import { expect, test } from "bun:test";
import express from "express";
import { AdminAuth } from "../security/adminAuth";
import { createAuthRoutes } from "../routes/authRoutes";
import { createAuthMiddleware } from "../middlewares/authMiddleware";

const username = "escritorio";
const password = "senha-de-teste-segura";

async function fixture(secure = false) {
  let now = Date.now();
  const credentials = { adminUsername: username, adminPassword: password };
  const auth = new AdminAuth(
    () => credentials,
    () => now,
  );
  const settings = {
    sessionSecure: secure,
    appOrigin: "https://notas.example.com",
  };
  await auth.init();
  let apiToken = "";
  const app = express();
  app.use("/auth", createAuthRoutes(auth, settings));
  app.use(
    "/api",
    createAuthMiddleware(auth, () => apiToken),
  );
  app.all("/api/test", (_req, res) => res.json({ success: true }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing address");
  const base = `http://127.0.0.1:${address.port}`;
  return {
    auth,
    credentials,
    base,
    advance: () => {
      now += auth.lifetimeMs;
    },
    token: (value: string) => {
      apiToken = value;
    },
    request: (route: string, init?: RequestInit) => fetch(base + route, init),
    login: (
      body: unknown = { username, password },
      extra: Record<string, string> = {},
    ) =>
      fetch(base + "/auth/login", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-nfse-request": "panel",
          ...extra,
        },
        body: JSON.stringify(body),
      }),
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}

test("administrator cookie protects reads and writes; CSRF and logout revoke access", async () => {
  const f = await fixture(true);
  try {
    expect((await f.request("/api/test")).status).toBe(401);
    expect((await f.login({ username, password: "incorrect" })).status).toBe(
      401,
    );
    expect((await f.login({ username: "outro", password })).status).toBe(401);
    const response = await f.login();
    expect(response.status).toBe(200);
    const setCookie = response.headers.get("set-cookie")!;
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("SameSite=Strict");
    expect(setCookie).toContain("Max-Age=28800");
    expect(setCookie).not.toContain(password);
    const cookie = setCookie.split(";")[0];
    const { csrfToken } = await response.json();
    expect(response.headers.get("cache-control")).toBe("no-store");
    const session = await f.request("/auth/session", { headers: { cookie } });
    expect((await session.json()).csrfToken).toBe(csrfToken);
    expect((await f.request("/api/test", { headers: { cookie } })).status).toBe(
      200,
    );
    expect(
      (await f.request("/api/test", { method: "POST", headers: { cookie } }))
        .status,
    ).toBe(403);
    const headers = {
      cookie,
      "x-csrf-token": csrfToken,
      "x-nfse-request": "panel",
    };
    expect(
      (await f.request("/api/test", { method: "POST", headers })).status,
    ).toBe(200);
    expect(
      (
        await f.request("/auth/logout", {
          method: "POST",
          headers: { cookie, "x-nfse-request": "panel" },
        })
      ).status,
    ).toBe(403);
    const logout = await f.request("/auth/logout", { method: "POST", headers });
    expect(logout.status).toBe(200);
    expect(logout.headers.get("set-cookie")).toContain(
      "Expires=Thu, 01 Jan 1970",
    );
    expect((await f.request("/api/test", { headers: { cookie } })).status).toBe(
      401,
    );
  } finally {
    f.close();
  }
});

test("expired sessions, changed credentials and server restarts require login", async () => {
  const f = await fixture();
  try {
    let response = await f.login();
    const cookie = response.headers.get("set-cookie")!.split(";")[0];
    expect(response.headers.get("set-cookie")).not.toContain("Secure");
    f.advance();
    expect((await f.request("/api/test", { headers: { cookie } })).status).toBe(
      401,
    );
    response = await f.login();
    const second = response.headers.get("set-cookie")!.split(";")[0];
    f.credentials.adminUsername = "novo";
    expect(
      (await f.request("/api/test", { headers: { cookie: second } })).status,
    ).toBe(401);
    f.credentials.adminUsername = username;
    const freshProcess = new AdminAuth(() => f.credentials);
    expect(freshProcess.get(second.split("=")[1])).toBeNull();
    response = await f.login();
    const third = response.headers.get("set-cookie")!.split(";")[0];
    f.credentials.adminPassword = "nova-senha-do-ambiente";
    expect(
      (await f.request("/api/test", { headers: { cookie: third } })).status,
    ).toBe(401);
    expect((await f.login()).status).toBe(401);
    expect(
      (
        await f.login({
          username,
          password: f.credentials.adminPassword,
        })
      ).status,
    ).toBe(200);
    f.credentials.adminPassword = "";
    expect((await f.login()).status).toBe(401);
  } finally {
    f.close();
  }
});

test("API token remains independent and an empty token never opens endpoints", async () => {
  const f = await fixture();
  try {
    for (const authorization of [
      "Bearer ",
      "Bearer incorrect",
      "Basic invalid",
    ]) {
      expect(
        (await f.request("/api/test", { headers: { authorization } })).status,
      ).toBe(401);
    }
    f.token("integration-secret");
    const credentials: Record<string, string>[] = [
      { authorization: "Bearer integration-secret" },
      { "x-api-key": "integration-secret" },
    ];
    for (const headers of credentials) {
      expect(
        (await f.request("/api/test", { method: "POST", headers })).status,
      ).toBe(200);
    }
    expect((await f.request("/api/test")).status).toBe(401);
  } finally {
    f.close();
  }
});

test("authentication rejects cross-origin requests and throttles password guessing", async () => {
  const f = await fixture();
  try {
    expect(
      (await f.login(undefined, { origin: "https://other.example.com" }))
        .status,
    ).toBe(403);
    expect((await f.login(undefined, { "x-nfse-request": "" })).status).toBe(
      403,
    );
    expect(
      (await f.login(undefined, { origin: "https://notas.example.com" }))
        .status,
    ).toBe(200);
    for (let attempt = 0; attempt < 9; attempt++) {
      expect((await f.login({ username, password: "wrong" })).status).toBe(401);
    }
    expect((await f.login()).status).toBe(429);
  } finally {
    f.close();
  }
});

test("login rejects malformed or oversized bodies without exposing credentials and rotates sessions", async () => {
  const f = await fixture();
  try {
    const headers = {
      "content-type": "application/json",
      "x-nfse-request": "panel",
    };
    const malformed = await f.request("/auth/login", {
      method: "POST",
      headers,
      body: '{"password":"private-password",',
    });
    expect(malformed.status).toBe(400);
    expect(await malformed.text()).not.toContain("private-password");
    const oversized = await f.login({ username, password: "x".repeat(5000) });
    expect(oversized.status).toBe(413);
    const first = await f.login();
    const firstCookie = first.headers.get("set-cookie")!.split(";")[0];
    const second = await f.login(undefined, { cookie: firstCookie });
    const secondCookie = second.headers.get("set-cookie")!.split(";")[0];
    expect(firstCookie).not.toBe(secondCookie);
    expect(
      (await f.request("/api/test", { headers: { cookie: firstCookie } }))
        .status,
    ).toBe(401);
    expect(
      (await f.request("/api/test", { headers: { cookie: secondCookie } }))
        .status,
    ).toBe(200);
  } finally {
    f.close();
  }
});
