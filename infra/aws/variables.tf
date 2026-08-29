variable "aws_region" {
  description = "AWS region for all resources."
  type        = string
  default     = "us-east-1"
}

variable "environment" {
  description = "Deployment environment name, used in tags and resource naming."
  type        = string
  default     = "prod"
}

variable "project" {
  description = "Short project name, used as a resource-naming prefix."
  type        = string
  default     = "agentobs"
}

# Single EC2 + Docker Compose, matching the mobscan deployment shape. AgentObs
# is a much lighter workload than mobscan (no jadx, no emulator, no DAST
# worker): it serves a small API and a static site, so it starts two sizes
# down. Revisit if the hosted team-sync tier takes real concurrent load.
variable "instance_type" {
  description = "EC2 instance type for the single application host."
  type        = string
  default     = "t3.small"
}

variable "root_volume_size_gb" {
  description = "Root EBS volume size in GB - Docker images, Postgres data, and synced session rows."
  type        = number
  default     = 30
}

variable "ssh_allowed_cidr" {
  description = "CIDR allowed to SSH (port 22). Set to your own IP/32, never 0.0.0.0/0."
  type        = string
}

variable "domain_name" {
  description = "Domain the app is served at. Used for the Name tag and as a reminder for the manual GoDaddy DNS step - Route53 is not used, since klars.ai is registered at GoDaddy."
  type        = string
  default     = "agents.klars.ai"
}
