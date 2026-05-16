// ecosystem.config.cjs — PM2 config for walichat-extended on docean_ubuntu
//
// IMPORTANT: PM2 does not auto-load .env files. Credentials must be set here.
// Do NOT commit real credentials — use placeholder values and set them manually
// on the server, or load them from /opt/walichat-extended/.env before pm2 start.
//
// DEPLOY (from repo root on Mac):
//   scp ecosystem.config.cjs docean_ubuntu:/opt/walichat-extended/
//   ssh docean_ubuntu "pm2 delete walichat-extended; pm2 start /opt/walichat-extended/ecosystem.config.cjs; pm2 save --force"

module.exports = {
  apps: [{
    name: 'walichat-extended',
    script: 'index.js',
    cwd: '/opt/walichat-extended',
    env: {
      MCP_TRANSPORT: 'http',
      PORT: '8003',
      NODE_ENV: 'production',
      // Set these on the server — do not commit real values
      WALICHAT_API_KEY: process.env.WALICHAT_API_KEY || 'SET_ON_SERVER',
      WALICHAT_DEVICE_ID: process.env.WALICHAT_DEVICE_ID || 'SET_ON_SERVER',
    }
  }]
}
