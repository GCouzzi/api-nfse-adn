import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export interface AdminCredentials {
  adminUsername: string;
  adminPassword: string;
}

interface Session {
  csrf: string;
  expiresAt: number;
  credentials: string;
}

export function constantTimeEqual(left: string, right: string): boolean {
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(left), digest(right));
}

// A single process owns these sessions. Restarts intentionally require login.
export class AdminAuth {
  private readonly sessions = new Map<string, Session>();
  private passwordHash?: { credentials: string; value: Promise<string> };
  readonly lifetimeMs = 8 * 60 * 60 * 1000;

  constructor(
    private readonly credentials: () => AdminCredentials,
    private readonly now: () => number = Date.now,
  ) {}

  private fingerprint(): string {
    const { adminUsername, adminPassword } = this.credentials();
    return createHash("sha256")
      .update(JSON.stringify([adminUsername, adminPassword]))
      .digest("hex");
  }

  async init(): Promise<void> {
    await this.preparePassword();
  }

  private preparePassword(): Promise<string> {
    const fingerprint = this.fingerprint();
    if (this.passwordHash?.credentials !== fingerprint) {
      this.sessions.clear();
      const { adminUsername, adminPassword } = this.credentials();
      this.passwordHash = {
        credentials: fingerprint,
        value:
          adminUsername && adminPassword
            ? Bun.password.hash(adminPassword, { algorithm: "argon2id" })
            : Promise.resolve(""),
      };
      return this.passwordHash.value;
    }
    return this.passwordHash.value;
  }

  async login(username: unknown, password: unknown) {
    const credentials = this.credentials();
    if (
      !credentials.adminUsername ||
      !credentials.adminPassword ||
      typeof username !== "string" ||
      typeof password !== "string" ||
      username.length > 200 ||
      password.length < 1 ||
      password.length > 1024
    ) {
      return null;
    }
    const fingerprint = this.fingerprint();
    let valid = false;
    try {
      valid = await Bun.password.verify(password, await this.preparePassword());
    } catch {
      return null;
    }
    if (
      !constantTimeEqual(username, credentials.adminUsername) ||
      !valid ||
      fingerprint !== this.fingerprint()
    ) {
      return null;
    }
    for (const [key, session] of this.sessions) {
      if (session.expiresAt <= this.now()) this.sessions.delete(key);
    }
    if (this.sessions.size >= 1000) {
      this.sessions.delete(this.sessions.keys().next().value!);
    }
    const token = randomBytes(32).toString("hex");
    const session: Session = {
      csrf: randomBytes(32).toString("hex"),
      expiresAt: this.now() + this.lifetimeMs,
      credentials: fingerprint,
    };
    this.sessions.set(this.key(token), session);
    return { token, ...session };
  }

  private key(token: string): string {
    return createHash("sha256").update(token).digest("hex");
  }

  get(token: string) {
    if (!/^[a-f0-9]{64}$/.test(token)) return null;
    const key = this.key(token);
    const session = this.sessions.get(key);
    if (
      !session ||
      session.expiresAt <= this.now() ||
      session.credentials !== this.fingerprint()
    ) {
      this.sessions.delete(key);
      return null;
    }
    return session;
  }

  logout(token: string): void {
    this.sessions.delete(this.key(token));
  }
}
