# AgentObs AWS deployment

Single EC2 instance running Docker Compose behind Caddy — the same shape as
mobscan's deployment (`klars-ai/mob-sec`, `infra/aws/`), deliberately reused so
there is one ops runbook and one cost profile across klars.ai products.

## Why not serverless

The original AgentObs spec proposed Lambda + Aurora Serverless v2 + Cognito +
API Gateway. That was overridden:

- klars.ai already runs one EC2 box with a known monthly cost and an
  established runbook. A second, differently-shaped stack doubles the
  operational surface for a solo operator.
- Aurora Serverless v2 has an ACU floor in most regions, so it is a real
  always-on cost — for this workload a `t3.small` covers the same job for less.
- Cognito's hosted-UI passwordless flow adds an integration to maintain when
  the app already needs its own account model.

Revisit if concurrent load or an uptime SLA justifies the added cost.

## Cost

Roughly **$20–30/month**: `t3.small` (~$15), 30GB gp3 (~$2.40), Elastic IP
attached to a running instance (free), egress (low). Meaningfully below
mobscan's ~$75/mo `t3.large`, because AgentObs has no jadx/emulator workload.

## First deploy

```bash
cd infra/aws
cp terraform.tfvars.example terraform.tfvars   # set ssh_allowed_cidr to your IP/32
terraform init
terraform apply
```

Then, in order:

1. **DNS.** `terraform output dns_instructions` prints the A record to create.
   klars.ai is registered at **GoDaddy**, so this is a manual step — Route 53 is
   not used. Do this *before* the app starts: Caddy's ACME challenge fails until
   the name resolves to the instance.

2. **Copy the deployment files** to the box:

   ```bash
   scp -i agentobs-app-key.pem ../../docker-compose.yml ../../Caddyfile \
       ec2-user@$(terraform output -raw public_ip):/opt/agentobs/
   ```

3. **Create `.env`** on the instance from `.env.example` at the repo root.
   Every secret has a generation command in the comments. `POSTGRES_PASSWORD`,
   `JWT_SECRET`, and `AGENTOBS_DASHBOARD_TOKEN` are all required — the server
   refuses to start without the last one rather than silently 401ing.

4. **Start it:**

   ```bash
   ssh -i agentobs-app-key.pem ec2-user@<ip>
   cd /opt/agentobs && docker compose up -d
   ```

Caddy obtains the TLS certificate on first request. `docker compose logs caddy`
shows the ACME exchange if HTTPS does not come up.

## Email

Uses **Resend** with the already-verified `klars.ai` domain — the same account
mobscan uses, so there is no new provider to set up and no DNS verification
wait. Set `RESEND_API_KEY`. Mail failures degrade silently by design (the
request still succeeds), so check container logs if an expected email never
arrives.

## Operational notes

- **The instance owns its own Postgres data** on the root EBS volume. There is
  no managed backup. `terraform destroy`, or replacing the instance, loses it —
  which is why `user_data` and `ami` are in `lifecycle.ignore_changes`.
- **`agentobs-app-key.pem` is gitignored.** Back it up outside git; losing it
  costs SSH access (recoverable via EC2 Instance Connect, but awkward).
- **Port 5432 is not published.** Postgres is reachable only on the compose
  network.
- **SSH is restricted to `ssh_allowed_cidr`.** Update `terraform.tfvars` and
  re-apply when your IP changes.
