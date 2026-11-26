import { getCloudflareContext } from "@opennextjs/cloudflare";

export const ADMIN_HANDLE = "管理人";

/** スキーマと管理人の初期データは migrations/ にある（wrangler d1 migrations apply） */
export async function env(): Promise<CloudflareEnv> {
  return (await getCloudflareContext({ async: true })).env;
}

async function d1(): Promise<D1Database> {
  return (await env()).DB;
}

type Param = string | number | null;

export async function stmt(sql: string, ...params: Param[]): Promise<D1PreparedStatement> {
  return (await d1()).prepare(sql).bind(...params);
}

export async function all<T>(sql: string, ...params: Param[]): Promise<T[]> {
  return (await (await stmt(sql, ...params)).all<T>()).results;
}

export async function first<T>(sql: string, ...params: Param[]): Promise<T | undefined> {
  return (await (await stmt(sql, ...params)).first<T>()) ?? undefined;
}

export async function run(sql: string, ...params: Param[]): Promise<D1Result> {
  return (await stmt(sql, ...params)).run();
}

/** 複数の文をまとめて実行する（D1 の batch はトランザクションとして扱われる） */
export async function batch(statements: D1PreparedStatement[]): Promise<D1Result[]> {
  return (await d1()).batch(statements);
}
