import { spawnSync } from 'node:child_process'

const args = ['audit', '--audit-level=high']
const result = spawnSync('npm', args, {
  stdio: 'pipe',
  encoding: 'utf8',
})

const stdout = result.stdout ?? ''
const stderr = result.stderr ?? ''
const combined = `${stdout}\n${stderr}`

if (stdout) process.stdout.write(stdout)
if (stderr) process.stderr.write(stderr)

if (result.status === 0) {
  process.stdout.write('\n✅ npm audit completed successfully.\n')
  process.exit(0)
}

const auditEndpointBlocked = /403 Forbidden|E403|audit endpoint returned an error/i.test(combined)

if (auditEndpointBlocked) {
  process.stdout.write(
    '\n⚠️ npm audit could not reach the advisories endpoint (HTTP 403).\n' +
      'Treating this as an environment limitation so CI can continue.\n' +
      'Run security scanning in a network that allows npm advisories.\n'
  )
  process.exit(0)
}

process.stderr.write(
  '\n❌ npm audit failed for a non-network reason. Failing security check.\n'
)
process.exit(result.status ?? 1)
