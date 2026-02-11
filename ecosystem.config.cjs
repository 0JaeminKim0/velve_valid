module.exports = {
  apps: [
    {
      name: 'valve-agent',
      script: 'npx',
      args: 'ts-node --transpile-only src/index.ts',
      cwd: '/home/user/webapp',
      env: {
        NODE_ENV: 'development',
        PORT: 3000,
        NODE_OPTIONS: '--max-old-space-size=2048'
      },
      watch: false,
      instances: 1,
      exec_mode: 'fork',
      max_restarts: 3,
      restart_delay: 3000,
      autorestart: true
    }
  ]
}
