// Auto-split from client.ts (issue #450). Mixin over the shared client context.
// Bodies are VERBATIM from the original DocmostClient; only the enclosing class
// changed to a mixin factory. See client/context.ts for the shared base.
import type { GConstructor, DocmostClientContext } from "./context.js";
import {
  collectInternalFileNodes,
  normalizeFileUrl,
  resolveInternalFilePath,
} from "../lib/internal-file-urls.js";

// Public method surface of StashMixin (issue #450) — a NAMED type so the factory
// return type is expressible in the emitted .d.ts (the anonymous mixin class
// carries the base's protected shared state, which would otherwise trip TS4094).
// Derived from the class below; `implements IStashMixin` fails to compile on drift.
export interface IStashMixin {
  stashPage(pageId: string): Promise<{ uri: string; sha256: string; size: number; images: { mirrored: number; failed: number }; }>;
}

export function StashMixin<TBase extends GConstructor<DocmostClientContext>>(Base: TBase): GConstructor<DocmostClientContext & IStashMixin> & TBase {
  abstract class StashMixin extends Base implements IStashMixin {
  /**
   * Fetch an INTERNAL Docmost file (authed loopback) for sandbox mirroring.
   * `src` is normalized to `/api/files/<id>/<file>`; `this.client.baseURL`
   * already ends in `/api`, so we strip the leading `/api` and request the
   * relative path with the client's Authorization header. Returns the raw bytes
   * and the response Content-Type (mime), defaulting to octet-stream.
   *
   * The fetch is size-bounded (hard 64 MiB ceiling) purely to protect memory;
   * the authoritative per-blob cap is enforced by the sandbox `put`. The path is
   * resolved via resolveInternalFilePath, which REJECTS (throws) any traversal
   * or percent-encoded src that would let an attacker-controlled `attrs.src`
   * escape `/api/files/` and reach another internal endpoint (SSRF). That throw
   * happens before this.client.get, so a malicious src is counted as a failed
   * mirror — it never reaches the network.
   */
  protected async fetchInternalFile(
    src: string,
  ): Promise<{ buffer: Buffer; mime: string }> {
    const HARD_CEILING = 64 * 1024 * 1024; // 64 MiB memory guard
    const relPath = resolveInternalFilePath(src);
    const response = await this.client.get(relPath, {
      responseType: "arraybuffer",
      timeout: 30000,
      maxContentLength: HARD_CEILING,
      maxBodyLength: HARD_CEILING,
    });
    const buffer = Buffer.from(response.data);
    if (buffer.length === 0) {
      throw new Error(`Empty file response from "${src}"`);
    }
    const rawCt = response.headers?.["content-type"];
    const mime =
      typeof rawCt === "string" && rawCt.length > 0
        ? rawCt.split(";")[0].trim().toLowerCase()
        : "application/octet-stream";
    return { buffer, mime };
  }

  /**
   * Stash a page's full content into the in-RAM blob sandbox and return ONLY a
   * short anonymous URL — the body never enters the model context (this is the
   * whole point: ~30KB+ ProseMirror docs blow the model context if passed as a
   * tool argument). Every INTERNAL file/image src (the type-agnostic criterion,
   * so drawio/excalidraw/video/file nodes are covered too) is mirrored into the
   * sandbox and its `src` rewritten to the sandbox URL, so an external consumer
   * can fetch the images anonymously. External http(s) srcs are left untouched.
   *
   * Blobs live in RAM with a short TTL and are cleared on restart — consume the
   * URLs within the TTL and one uptime. A failed image fetch never aborts the
   * doc: the original src is kept and the failure counted.
   *
   * Returns { uri, sha256, size, images:{mirrored, failed} }. `uri` and `sha256`
   * are for the document blob; `sha256` is also the blob's ETag (integrity).
   */
  async stashPage(pageId: string): Promise<{
    uri: string;
    sha256: string;
    size: number;
    images: { mirrored: number; failed: number };
  }> {
    if (!this.sandboxPut) {
      throw new Error(
        "stashPage is unavailable: the blob sandbox is not configured on this server",
      );
    }
    await this.ensureAuthenticated();

    // Stash the SAME shape getPageJson returns (id/title/.../content), with a
    // deep clone so the rewrite never mutates anything shared.
    const pageJson = await this.getPageJson(pageId);
    const cloned: any = structuredClone(pageJson);

    // Group internal-file nodes by normalized src so each unique resource is
    // fetched + stored ONCE (dedup), and every node sharing that src points at
    // the one sandbox blob. Capture each node's ORIGINAL raw src per-node:
    // dedup groups nodes whose normalized src is equal even when their raw srcs
    // differ (e.g. `/api/files/...` vs the bare `/files/...`), so on a revert we
    // must restore each node's own original value, not the group key.
    const bySrc = new Map<string, Array<{ node: any; origSrc: string }>>();
    for (const node of collectInternalFileNodes(cloned.content)) {
      const origSrc = String(node.attrs.src);
      const src = normalizeFileUrl(origSrc);
      const entry = { node, origSrc };
      const group = bySrc.get(src);
      if (group) group.push(entry);
      else bySrc.set(src, [entry]);
    }

    let mirrored = 0;
    let failed = 0;
    // Record every successful mirror so it can be (a) reverted if its blob gets
    // FIFO-evicted by a LATER put in this same stash, and (b) freed if the final
    // doc put throws.
    const mirrors: Array<{
      uri: string;
      entries: Array<{ node: any; origSrc: string }>;
    }> = [];
    const MAX_CONCURRENCY = 5;
    const groups = [...bySrc.entries()];
    for (let i = 0; i < groups.length; i += MAX_CONCURRENCY) {
      const batch = groups.slice(i, i + MAX_CONCURRENCY);
      await Promise.all(
        batch.map(async ([src, entries]) => {
          try {
            const { buffer, mime } = await this.fetchInternalFile(src);
            // put may throw if the blob exceeds the per-blob/total caps.
            const stored = this.sandboxPut!(buffer, mime);
            for (const entry of entries) entry.node.attrs.src = stored.uri;
            mirrors.push({ uri: stored.uri, entries });
            mirrored++;
          } catch (err) {
            // One bad/oversized image (or a rejected traversal src) must not
            // abort the document. Logged unconditionally (never the blob body),
            // matching the package's ungated console.warn convention.
            failed++;
            console.warn(
              `stashPage: failed to mirror "${src}": ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          }
        }),
      );
    }

    // Revert one mirror's nodes to their original internal srcs and re-count it
    // as failed (its blob was FIFO-evicted before the doc could reference it
    // safely).
    const revertMirror = (mirror: {
      uri: string;
      entries: Array<{ node: any; origSrc: string }>;
    }) => {
      for (const entry of mirror.entries) entry.node.attrs.src = entry.origSrc;
      mirrored--;
      failed++;
      console.warn(
        `stashPage: mirrored blob ${mirror.uri} was evicted before the doc ` +
          `could safely reference it; reverted its src and counted it as failed`,
      );
    };

    // Pre-put reconciliation: an image put earlier in THIS stash can FIFO-evict
    // an even-earlier image of the same stash. Drop those from the live set
    // first so the first serialized doc is already mostly correct.
    let liveMirrors = mirrors;
    if (this.sandboxHas) {
      liveMirrors = [];
      for (const mirror of mirrors) {
        if (this.sandboxHas(mirror.uri)) liveMirrors.push(mirror);
        else revertMirror(mirror);
      }
    }

    // Put the document, then reconcile against eviction caused by the doc put
    // ITSELF (the doc is newest, FIFO drops oldest = this stash's images). Each
    // iteration reverts >=1 mirror, so the loop terminates (worst case: all
    // images reverted and the doc references no sandbox image URLs).
    let stored: { uri: string; sha256: string; size: number };
    for (;;) {
      const docBuf = Buffer.from(JSON.stringify(cloned), "utf8");
      let docStored: { uri: string; sha256: string; size: number };
      try {
        docStored = this.sandboxPut(docBuf, "application/json");
      } catch (err) {
        // The doc put failed (e.g. doc exceeds the cap). Free this op's image
        // blobs instead of leaking them in RAM for the whole TTL, then
        // re-throw.
        if (this.sandboxEvict) {
          for (const mirror of liveMirrors) this.sandboxEvict(mirror.uri);
        }
        throw err;
      }

      if (!this.sandboxHas) {
        stored = docStored;
        break;
      }
      const evictedNow = liveMirrors.filter((m) => !this.sandboxHas!(m.uri));
      if (evictedNow.length === 0) {
        stored = docStored;
        break;
      }
      // The doc we just stored references now-dead blobs. Revert those nodes,
      // drop the stale doc blob, and loop to re-serialize + re-put the
      // corrected doc.
      for (const mirror of evictedNow) revertMirror(mirror);
      liveMirrors = liveMirrors.filter((m) => this.sandboxHas!(m.uri));
      if (this.sandboxEvict) this.sandboxEvict(docStored.uri);
    }
    return {
      uri: stored.uri,
      sha256: stored.sha256,
      size: stored.size,
      images: { mirrored, failed },
    };
  }

  /**
   * Compact outline of a page's top-level blocks (no full document body).
   * Cheap way to locate sections/tables and grab block ids before drilling in
   * with getNode / patchNode / insertNode.
   */
  }
  return StashMixin;
}
