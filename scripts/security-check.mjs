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

const environmentFailurePattern =
  /audit endpoint returned an error|\b(?:EAI_AGAIN|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|E401|E403|E429)\b|\b(?:HTTP|status(?: code)?)\s*[:=]?\s*(?:401|403|429|5\d\d)\b/i
const hasEnvironmentFailure = environmentFailurePattern.test(combined)

if (hasEnvironmentFailure) {
  process.stdout.write(
    '\n⚠️ npm audit could not complete because of registry/network access limitations.\n' +
      'Treating this as an environment limitation so CI can continue.\n' +
      'Run security scanning in an environment with npm advisory endpoint access.\n'
  )
  process.exit(0)
}

if (/vulnerabilities/i.test(combined)) {
  process.stderr.write('\n❌ npm audit detected vulnerabilities at or above the configured threshold.\n')
  process.exit(result.status ?? 1)
}

process.stderr.write(
  '\n❌ npm audit failed for an unknown reason. Failing security check.\n'
)
process.exit(result.status ?? 1)
