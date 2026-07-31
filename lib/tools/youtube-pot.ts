import { JSDOM } from "jsdom";
import { Innertube } from "youtubei.js";
import { BotGuardClient } from "bgutils-js/botguard";
import type { WebPoSignalOutput } from "bgutils-js/shared-types";
import { buildURL, getHeaders } from "bgutils-js/utils";
import { WebPoMinter } from "bgutils-js/webpo";

/**
 * PO ("proof of origin") token support for YouTube access from datacenter
 * IPs. YouTube answers the InnerTube API with LOGIN_REQUIRED ("Sign in to
 * confirm you're not a bot") from such networks; a BotGuard attestation
 * run through bgutils-js mints a WebPO token that, bound to the session's
 * visitor data, makes WEB-client player requests pass again.
 *
 * The BotGuard VM needs browser-like globals INSTALLED FOR GOOD: scoping
 * them to a jsdom window or tearing them down after each phase makes the
 * VM refuse to hand out its minter (verified empirically — APF:Failed /
 * PMD:Undefined). So jsdom's window/document are assigned onto globalThis
 * permanently, exactly like the reference implementation. That is safe
 * here because this module only ever runs inside the API-route process on
 * a bot-walled network (production lambdas, which render no pages); local
 * dev traffic is not bot-walled and never reaches this code.
 */

// Public request key used by the YouTube web client for WebPO minting.
const REQUEST_KEY = "O43z0dpjhgX20SCx4KAo";
// Re-mint ahead of the token's real TTL (~hours); 6h is comfortably safe.
const SESSION_TTL_MS = 6 * 60 * 60 * 1000;
const TTL_MARGIN_MS = 5 * 60 * 1000;

let domInstalled = false;

function installDomGlobals(): void {
  if (domInstalled) return;
  const dom = new JSDOM(
    '<!DOCTYPE html><html lang="en"><head><title></title></head><body></body></html>',
    { url: "https://www.youtube.com/", referrer: "https://www.youtube.com/" },
  );
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    location: dom.window.location,
    origin: dom.window.origin,
  });
  // Node >= 21 has its own global navigator; the reference implementation
  // leaves it in place, and the VM accepts it.
  if (!Reflect.has(globalThis, "navigator")) {
    Object.defineProperty(globalThis, "navigator", {
      value: dom.window.navigator,
      configurable: true,
    });
  }
  domInstalled = true;
}

export interface PotSession {
  /** Innertube whose WEB-client requests carry the session PO token. */
  innertube: Innertube;
  /** Mints a content-bound token (append as &pot= to caption/media URLs). */
  mintContentToken: (videoId: string) => Promise<string>;
}

let cached: { session: PotSession; expiresAt: number } | null = null;
let inflight: Promise<PotSession | null> | null = null;

async function createPotSession(): Promise<PotSession | null> {
  try {
    installDomGlobals();

    const base = await Innertube.create({ retrieve_player: false });
    const visitorData = base.session.context.client.visitorData;
    if (!visitorData) return null;

    const challengeResponse = await base.getAttestationChallenge(
      "ENGAGEMENT_TYPE_UNBOUND",
    );
    const bgChallenge = challengeResponse.bg_challenge;
    if (!bgChallenge) return null;

    const interpreterUrl =
      bgChallenge.interpreter_url
        .private_do_not_access_or_else_trusted_resource_url_wrapped_value;
    const interpreterJavascript = await fetch(`https:${interpreterUrl}`, {
      signal: AbortSignal.timeout(10000),
    }).then((r) => (r.ok ? r.text() : ""));
    if (!interpreterJavascript) return null;

    new Function(interpreterJavascript)();

    const botGuardClient = await BotGuardClient.create({
      program: bgChallenge.program,
      globalName: bgChallenge.global_name,
      globalObject: globalThis as unknown as Record<string, unknown>,
    });

    const webPoSignalOutput: WebPoSignalOutput = [];
    const botguardResponse = await botGuardClient.snapshot({
      webPoSignalOutput,
    });

    const integrityTokenResponse = await fetch(buildURL("GenerateIT", false), {
      method: "POST",
      headers: getHeaders(),
      body: JSON.stringify([REQUEST_KEY, botguardResponse]),
      signal: AbortSignal.timeout(10000),
    });
    if (!integrityTokenResponse.ok) return null;
    const [integrityToken, estimatedTtlSecs, mintRefreshThreshold, websafeFallbackToken] =
      (await integrityTokenResponse.json()) as [string, number, number, string];

    const minter = await WebPoMinter.create(
      { integrityToken, estimatedTtlSecs, mintRefreshThreshold, websafeFallbackToken },
      webPoSignalOutput,
    );

    const sessionPoToken = await minter.mintAsWebsafeString(visitorData);

    // Unlike the two bootstrap instances above, this one needs the player:
    // WEB-client getInfo answers UNPLAYABLE without it even when the PO
    // token is valid (verified locally).
    const innertube = await Innertube.create({
      po_token: sessionPoToken,
      visitor_data: visitorData,
    });

    const session: PotSession = {
      innertube,
      mintContentToken: (videoId: string) => minter.mintAsWebsafeString(videoId),
    };
    const ttlMs = Math.min(
      (estimatedTtlSecs || 0) * 1000 || SESSION_TTL_MS,
      SESSION_TTL_MS,
    );
    cached = { session, expiresAt: Date.now() + ttlMs - TTL_MARGIN_MS };
    return session;
  } catch (err) {
    if (process.env.POT_DEBUG) console.error("[pot]", err);
    return null;
  }
}

/** Drops the cached session — for when its visitor is scored as a bot
 *  anyway; the next getPotSession() attests from scratch with a fresh
 *  visitor identity. */
export function invalidatePotSession(): void {
  cached = null;
}

/** Cached PO-token session; null when attestation cannot be completed. */
export function getPotSession(): Promise<PotSession | null> {
  if (cached && Date.now() < cached.expiresAt) {
    return Promise.resolve(cached.session);
  }
  if (!inflight) {
    inflight = createPotSession().finally(() => {
      inflight = null;
    });
  }
  return inflight;
}
