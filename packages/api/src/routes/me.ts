import type { Route } from "../types.js";

/** GET /v1/me: the signed-in operator and whether Rovara reports them as an administrator (for `whoami`). */
export const routes: Route[] = [
  {
    method: "GET",
    pattern: "/v1/me",
    handler: async ({ operator, access }) => ({ status: 200, body: { id: operator.id, name: operator.name, isAdmin: access.isAdmin } }),
  },
];
