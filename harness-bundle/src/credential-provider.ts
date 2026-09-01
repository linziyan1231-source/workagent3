import type { Context } from "@deepseek-ai/cordis";
import CredentialProvider, {
  type CredentialKey,
  type CredentialRecord,
  type CredentialRef,
} from "@deepseek-ai/dsh-credentials";

/**
 * Runtime-only projection of credentials owned by the SID Credential Broker.
 *
 * UserHost republishes the protected values after every Harness start. Keeping
 * this provider memory-only prevents the official file provider from copying
 * secrets into DSH_HOME/.credentials.yaml while preserving the official
 * ctx.credentials capability seam for every consumer.
 */
export default class WorkAgentCredentialProvider extends CredentialProvider {
  private readonly references = new Map<CredentialRef, string>();
  private readonly records = new Map<CredentialKey, CredentialRecord>();

  constructor(ctx: Context) {
    super(ctx);
  }

  resolve(ref: CredentialRef) {
    const value = this.references.get(ref);
    return Promise.resolve(
      value === undefined
        ? undefined
        : { value, source: "workagent-broker-projection" },
    );
  }

  describe(ref: CredentialRef) {
    return Promise.resolve({
      configured: this.references.has(ref),
      ...(this.references.has(ref)
        ? { source: "workagent-broker-projection" }
        : {}),
      writable: true,
    });
  }

  set(ref: CredentialRef, value: string): Promise<void> {
    if (value.length === 0)
      return Promise.reject(
        new Error("an empty credential cannot be projected"),
      );
    if (this.references.get(ref) === value) return Promise.resolve();
    this.references.set(ref, value);
    this.notifyUpdated(ref);
    return Promise.resolve();
  }

  unset(ref: CredentialRef): Promise<void> {
    if (!this.references.delete(ref)) return Promise.resolve();
    this.notifyUpdated(ref);
    return Promise.resolve();
  }

  readRecord(key: CredentialKey): Promise<CredentialRecord | undefined> {
    return Promise.resolve(this.records.get(key));
  }

  describeRecord(key: CredentialKey) {
    const record = this.records.get(key);
    return Promise.resolve({
      configured: record !== undefined,
      ...(record === undefined ? {} : { kind: record.kind }),
      writable: true,
    });
  }

  listRecords() {
    return Promise.resolve(
      [...this.records].map(([key, record]) => ({ key, kind: record.kind })),
    );
  }

  async modifyRecord(
    key: CredentialKey,
    mutate: (
      current: CredentialRecord | undefined,
    ) => Promise<CredentialRecord | undefined>,
  ): Promise<CredentialRecord | undefined> {
    const current = this.records.get(key);
    const next = await mutate(current);
    if (next === undefined) return current;
    this.records.set(key, next);
    this.notifyRecordUpdated(key);
    return next;
  }

  deleteRecord(key: CredentialKey): Promise<void> {
    if (!this.records.delete(key)) return Promise.resolve();
    this.notifyRecordUpdated(key);
    return Promise.resolve();
  }
}
