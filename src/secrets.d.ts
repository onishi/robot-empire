// `wrangler secret put` で設定するシークレット
interface CloudflareEnv {
  GOOGLE_AI_API_KEY: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  SESSION_SECRET: string;
  CRON_SECRET: string;
}
