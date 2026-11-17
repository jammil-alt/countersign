// Secrets on this computer (docs/plan.md §1.124): the computer's private key and the person's
// session. Each is encrypted by the operating system (Electron's safeStorage: the Keychain on a
// Mac, DPAPI on Windows) before it is written, in its own file readable only by this user.
// DECISION: no secret is kept where the OS can't encrypt it: on a machine without a keychain the
// app refuses to pair rather than keep a key in the clear.

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface Crypt {
  available(): boolean;
  encrypt(plain: string): Buffer;
  decrypt(sealed: Buffer): string;
}

export type SecretName = "device-key" | "session";

export class Vault {
  constructor(
    private readonly dir: string,
    private readonly crypt: Crypt,
  ) {}

  available(): boolean {
    return this.crypt.available();
  }

  private file(name: SecretName): string {
    return join(this.dir, "secrets", `${name}.bin`);
  }

  async get(name: SecretName): Promise<string | null> {
    try {
      return this.crypt.decrypt(await readFile(this.file(name)));
    } catch {
      return null;
    }
  }

  async set(name: SecretName, value: string): Promise<void> {
    if (!this.crypt.available()) {
      throw new Error("This computer can't keep secrets safely, so Mezonas won't store them.");
    }
    await mkdir(join(this.dir, "secrets"), { recursive: true, mode: 0o700 });
    await writeFile(this.file(name), this.crypt.encrypt(value), { mode: 0o600 });
  }

  async delete(name: SecretName): Promise<void> {
    await rm(this.file(name), { force: true });
  }
}
