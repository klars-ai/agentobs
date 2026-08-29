output "public_ip" {
  description = "Elastic IP - point the GoDaddy A record for the domain at this."
  value       = aws_eip.app.public_ip
}

output "ssh_command" {
  description = "SSH into the application host."
  value       = "ssh -i ${path.module}/${var.project}-app-key.pem ec2-user@${aws_eip.app.public_ip}"
}

output "dns_instructions" {
  description = "Manual DNS step - klars.ai is at GoDaddy, so Route53 is not used."
  value       = "Create an A record for ${var.domain_name} -> ${aws_eip.app.public_ip} in the GoDaddy DNS panel. Caddy issues the TLS certificate automatically once DNS resolves."
}

output "instance_id" {
  value = aws_instance.app.id
}
