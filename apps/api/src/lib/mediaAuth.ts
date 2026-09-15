import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getCachedTokenVersion } from "./tokenVersion.js";
import { isSessionActive } from "./sessionService.js";

export const MEDIA_COOKIE_NAME = "continuixai_media";
/**
 * 미디어 쿠키 수명 — /api/auth/me가 앱 부팅마다 갱신하므로 24h로 둬도 된다.
 * (JWT 7d와 별개; me가 쿠키를 슬라이딩 갱신한다.)
 */
export const MEDIA_TOKEN_EXPIRES = "24h";
const MEDIA_COOKIE_MAX_AGE_SEC = 60 * 60 * 24;

export function mediaCookieOptions() {
  return {
    path: "/api/attachments/file",
    httpOnly: true,
    sameSite: "lax" as const,
    // Proxmox 기본 배포가 HTTP라 무조건 secure를 켜면 기본 설치에서 사진이 안 뜬다.
    // HTTPS면 compose에 COOKIE_SECURE=true를 넘긴다.
    secure: process.env.COOKIE_SECURE === "true",
    maxAge: MEDIA_COOKIE_MAX_AGE_SEC,
  };
}

export function clearMediaCookieOptions() {
  return {
    path: "/api/attachments/file",
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.COOKIE_SECURE === "true",
  };
}

export function signMediaToken(app: FastifyInstance, userId: string, tokenVersion: number, sessionId: string): string {
  // purpose:"media"만 담는다 — role/tv 없음. authenticate가 purpose === "media"를 거부해야
  // 이 토큰이 Authorization Bearer로 API 전체에 쓰이지 않는다.
  return app.jwt.sign({ sub: userId, tv: tokenVersion, sid: sessionId, purpose: "media" }, { expiresIn: MEDIA_TOKEN_EXPIRES });
}

export function setMediaCookie(app: FastifyInstance, reply: FastifyReply, userId: string, tokenVersion: number, sessionId: string): void {
  reply.setCookie(MEDIA_COOKIE_NAME, signMediaToken(app, userId, tokenVersion, sessionId), mediaCookieOptions());
}

export function clearMediaCookie(reply: FastifyReply): void {
  reply.clearCookie(MEDIA_COOKIE_NAME, clearMediaCookieOptions());
}

/** 개발(교차 오리진)에서만 명시적으로 끄는 opt-in. 기본은 항상 인증을 강제한다. */
export function isMediaAuthDisabled(): boolean {
  return process.env.MEDIA_AUTH_DISABLED === "true";
}

/**
 * 첨부 파일 라우트 인증.
 * continuixai_media 쿠키(purpose:media) 또는 Authorization Bearer(일반 API 토큰) 필수.
 * 교차 오리진 로컬 개발은 MEDIA_AUTH_DISABLED=true로만 우회한다 — NODE_ENV만으로는 끄지 않는다.
 */
export async function requireMediaAccess(
  app: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<boolean> {
  if (isMediaAuthDisabled()) {
    return true;
  }

  const cookieToken = request.cookies?.[MEDIA_COOKIE_NAME];
  if (typeof cookieToken === "string" && cookieToken.length > 0) {
    try {
      const decoded = app.jwt.verify<{ sub: string; tv?: number; sid?: string; purpose?: string }>(cookieToken);
      if (decoded.purpose === "media" && decoded.sub && typeof decoded.tv === "number" && decoded.sid) {
        const current = await getCachedTokenVersion(decoded.sub);
        if (current === decoded.tv && await isSessionActive(decoded.sid, decoded.sub, decoded.tv)) return true;
      }
    } catch {
      // fall through
    }
  }

  const auth = request.headers.authorization;
  if (auth?.startsWith("Bearer ")) {
    try {
      await request.jwtVerify();
      const { sub, tv, sid } = request.user;
      if (sub && typeof tv === "number" && sid) {
        const current = await getCachedTokenVersion(sub);
        if (current === tv && await isSessionActive(sid, sub, tv)) return true;
      }
    } catch {
      // fall through
    }
  }

  reply.code(401).send({ error: "unauthorized" });
  return false;
}
