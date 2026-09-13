module.exports = {
  apps: [
    {
      name: "yyagentd",
      cwd: __dirname,
      script: "./node_modules/tsx/dist/cli.mjs",
      args: "src/main.ts start",
      time: true,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
      out_file: "logs/pm2-out.log",
      error_file: "logs/pm2-err.log",
      merge_logs: true,
    },
  ],
};
