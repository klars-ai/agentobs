# Single EC2 + Docker Compose deployment, deliberately mirroring the mobscan
# stack (infra/aws in that repo) rather than the serverless design the original
# AgentObs spec proposed.
#
# Why not Lambda + Aurora Serverless v2 + Cognito: klars.ai already runs one
# EC2 box with a known cost profile and one ops runbook. A second, differently
# shaped stack would double the operational surface for a solo operator, and
# Aurora Serverless v2's ACU floor is a real always-on cost that a t3.small
# already covers for a workload this size.
#
# Accepted tradeoffs, same as mobscan: no auto-scaling, no managed failover,
# this instance owns its own Postgres data on the root EBS volume. Reasonable
# for an early-stage deployment; revisit when uptime SLAs justify the cost.

data "aws_vpc" "default" {
  default = true
}

data "aws_subnets" "default" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default.id]
  }
}

# Amazon Linux 2023 - free-tier eligible, Docker via `dnf install docker`,
# no separate AMI subscription.
data "aws_ami" "al2023" {
  most_recent = true
  owners      = ["amazon"]

  filter {
    name   = "name"
    values = ["al2023-ami-*-x86_64"]
  }

  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
}

resource "aws_security_group" "app" {
  name        = "${var.project}-app-sg"
  description = "AgentObs application host - SSH (restricted), HTTP/HTTPS (public)"
  vpc_id      = data.aws_vpc.default.id

  ingress {
    description = "SSH from operator IP only"
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = [var.ssh_allowed_cidr]
  }

  ingress {
    description = "HTTP from internet (redirected to HTTPS by Caddy)"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    description = "HTTPS from internet"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    description = "All outbound"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "${var.project}-app-sg"
  }
}

# Generated locally; the private key never leaves this machine. The .pem is
# written to infra/aws/ and gitignored - back it up outside git. Losing it
# costs SSH access (recoverable via EC2 Instance Connect / SSM, but simplest
# to just keep the file).
resource "tls_private_key" "app" {
  algorithm = "RSA"
  rsa_bits  = 4096
}

resource "aws_key_pair" "app" {
  key_name   = "${var.project}-app-key"
  public_key = tls_private_key.app.public_key_openssh
}

resource "local_sensitive_file" "app_private_key" {
  content         = tls_private_key.app.private_key_pem
  filename        = "${path.module}/${var.project}-app-key.pem"
  file_permission = "0600"
}

resource "aws_instance" "app" {
  ami                    = data.aws_ami.al2023.id
  instance_type          = var.instance_type
  subnet_id              = data.aws_subnets.default.ids[0]
  vpc_security_group_ids = [aws_security_group.app.id]
  key_name               = aws_key_pair.app.key_name

  root_block_device {
    volume_size           = var.root_volume_size_gb
    volume_type           = "gp3"
    encrypted             = true
    delete_on_termination = true
  }

  # Installs Docker and the compose plugin only. The application itself is
  # deployed by the GitHub Actions workflow rather than baked in here, so a
  # code change never requires a terraform apply.
  user_data = <<-EOT
    #!/bin/bash
    set -euxo pipefail
    dnf update -y
    dnf install -y docker git
    systemctl enable --now docker
    usermod -aG docker ec2-user
    mkdir -p /usr/local/lib/docker/cli-plugins
    curl -SL https://github.com/docker/compose/releases/download/v2.29.7/docker-compose-linux-x86_64 \
      -o /usr/local/lib/docker/cli-plugins/docker-compose
    chmod +x /usr/local/lib/docker/cli-plugins/docker-compose
    mkdir -p /opt/agentobs
    chown ec2-user:ec2-user /opt/agentobs
  EOT

  # Replacing the instance would destroy the Postgres data on the root volume.
  # Changing user_data is the realistic trigger, so it is ignored after the
  # first boot - update the box over SSH instead.
  lifecycle {
    ignore_changes = [user_data, ami]
  }

  tags = {
    Name        = "${var.project}-app"
    Environment = var.environment
    Domain      = var.domain_name
  }
}

# A static address so the GoDaddy A record survives instance stop/start.
resource "aws_eip" "app" {
  instance = aws_instance.app.id
  domain   = "vpc"

  tags = {
    Name = "${var.project}-app-eip"
  }
}
