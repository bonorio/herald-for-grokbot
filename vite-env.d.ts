// The one Node API the Vite config uses; the project's types are for Workers, not Node.
declare module "node:fs" {
  export function existsSync(path: string): boolean;
}
