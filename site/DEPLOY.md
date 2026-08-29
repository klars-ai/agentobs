# Deploying the landing page to agents.klars.ai

The page is four static files (128 KB total). It co-hosts on the existing
mobscan EC2 instance (`18.205.118.14`), which already serves `scan.klars.ai`
and owns ports 80/443 through its Caddy container.

**No new infrastructure and no new AWS cost.** The tradeoff accepted is
coupling: one Caddy process now serves both sites, so a bad Caddyfile takes
`scan.klars.ai` down too. That is why step 3 validates the config *before*
reloading, rather than restarting and hoping.

DNS is already correct — `agents.klars.ai` resolves to `18.205.118.14`.

---

## 1. Copy the site to the instance

From this repo's root, on your machine:

```bash
cd i:\AgentObs

scp -i H:/Security/mobscan-scaffold/mobscan/infra/aws/mobscan-app-key.pem \
    -r site/index.html site/site.css site/dashboard.png site/dashboard-dark.png \
    ec2-user@18.205.118.14:/tmp/agentobs-site/
```

If `scp` reports the directory is missing, create it first:

```bash
ssh -i H:/Security/mobscan-scaffold/mobscan/infra/aws/mobscan-app-key.pem \
    ec2-user@18.205.118.14 "mkdir -p /tmp/agentobs-site"
```

## 2. Move it into place and add the Caddy site block

SSH in:

```bash
ssh -i H:/Security/mobscan-scaffold/mobscan/infra/aws/mobscan-app-key.pem \
    ec2-user@18.205.118.14
```

Then, on the instance:

```bash
cd /opt/mobscan          # wherever docker-compose.yml lives

# Static files, served read-only into the Caddy container.
sudo mkdir -p /opt/mobscan/agentobs-site
sudo cp /tmp/agentobs-site/* /opt/mobscan/agentobs-site/

# Back up the Caddyfile before editing - this file also serves scan.klars.ai.
cp Caddyfile Caddyfile.bak-$(date +%F)
```

Append this **new site block** to `Caddyfile`. Leave the existing
`{$CADDY_DOMAIN}` block exactly as it is:

```caddyfile
# AgentObs landing page - static files, no backend.
# Separate site block from scan.klars.ai above; Caddy issues and renews a
# certificate for this hostname independently.
agents.klars.ai {
	encode gzip
	root * /srv/agentobs
	file_server

	header {
		Strict-Transport-Security "max-age=31536000; includeSubDomains"
		X-Content-Type-Options "nosniff"
		X-Frame-Options "DENY"
		Referrer-Policy "strict-origin-when-cross-origin"
		-Server
	}

	# Long cache on the screenshots, none on the HTML, so a content edit
	# shows up immediately while images stay cheap.
	@static path *.png *.css
	header @static Cache-Control "public, max-age=604800"
	header /index.html Cache-Control "no-cache"
}
```

Mount the directory into the Caddy container. In `docker-compose.prod.yml`,
add one line to the `caddy` service's `volumes:`:

```yaml
      - ./agentobs-site:/srv/agentobs:ro
```

## 3. Validate BEFORE reloading

This is the step that protects `scan.klars.ai`. A syntax error caught here
costs nothing; the same error after a restart takes both sites down.

```bash
docker compose exec caddy caddy validate --config /etc/caddy/Caddyfile
```

Only continue if it prints `Valid configuration`.

## 4. Apply

The volume is new, so the container must be recreated (a reload alone will
not pick it up):

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d caddy
```

## 5. Verify both sites

```bash
curl -sI https://scan.klars.ai   | head -1   # must still be 200 - mobscan
curl -sI https://agents.klars.ai | head -1   # 200 once the cert is issued
```

The first request to `agents.klars.ai` triggers a Let's Encrypt challenge and
may take 10-30 seconds. Watch it with:

```bash
docker compose logs --tail 40 caddy
```

## Rollback

```bash
cp Caddyfile.bak-<date> Caddyfile
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d caddy
```

## Updating the page later

Re-copy the files and hard-refresh; no container restart is needed, since the
volume is read live and `index.html` is sent with `no-cache`.
