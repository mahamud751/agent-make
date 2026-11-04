import type { Role, ApiKeyKind } from "@prisma/client";

export interface RequestContext {
  tenantId: string;
  actor:
    | { type: "user"; id: string; role: Role }
    | { type: "api_key"; id: string; kind: ApiKeyKind };
}

declare global {
  namespace Express {
    interface Request {
      ctx?: RequestContext;
      rawBody?: string;
    }
  }
}
