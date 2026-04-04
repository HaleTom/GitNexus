import { createServer } from '../server/api.js';

// Catch anything that would cause a silent exit
process.on('uncaughtException', (err) => {
  console.error('\n[gitnexus serve] Uncaught exception:', err.message);
  if (process.env.DEBUG) console.error(err.stack);
  process.exit(1);
});
process.on('unhandledRejection', (reason: any) => {
  console.error('\n[gitnexus serve] Unhandled rejection:', reason?.message || reason);
  if (process.env.DEBUG) console.error(reason?.stack);
  process.exit(1);
});

export const serveCommand = async (options?: { port?: string; host?: string }) => {
  const port = Number(options?.port ?? 4747);
  // Default to '::' (dual-stack) so the server is reachable via both 127.0.0.1
  // and ::1.  Browsers may resolve 'localhost' to either address; binding only
  // to 127.0.0.1 breaks IPv6-first systems and causes spurious CORS errors
  // when the hosted frontend at gitnexus.vercel.app connects to localhost.
  const host = options?.host ?? '::';

  try {
    await createServer(port, host);
  } catch (err: any) {
    console.error(`\nFailed to start GitNexus server:\n`);
    console.error(`  ${err.message || err}\n`);
    if (err.code === 'EADDRINUSE') {
      console.error(`  Port ${port} is already in use. Either:`);
      console.error(`    1. Stop the other process using port ${port}`);
      console.error(`    2. Use a different port: gitnexus serve --port 4748\n`);
    }
    if (err.stack && process.env.DEBUG) {
      console.error(err.stack);
    }
    process.exit(1);
  }
};
