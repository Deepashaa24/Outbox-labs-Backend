import { z } from "zod";
import { config } from "../config/env.js";
import { prisma } from "../db/prisma.js";

const accessTokenSchema = z.object({
  access_token: z.string().min(1)
});

const googleProfileSchema = z.object({
  sub: z.string().min(1),
  email: z.string().email(),
  email_verified: z.boolean(),
  name: z.string().optional(),
  picture: z.preprocess(
    (value) => value === "" ? undefined : value,
    z.string().url().optional()
  )
});

export interface AuthenticatedUser {
  id: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
}

function getCallbackUrl(): string {
  if (!config.GOOGLE_CLIENT_ID || !config.GOOGLE_CLIENT_SECRET || !config.GOOGLE_CALLBACK_URL) {
    throw new Error("Google OAuth is not configured. Set its client ID, secret, and callback URL.");
  }
  return config.GOOGLE_CALLBACK_URL;
}

export function getGoogleAuthorizationUrl(state: string): string {
  const authorizationUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authorizationUrl.search = new URLSearchParams({
    client_id: config.GOOGLE_CLIENT_ID,
    redirect_uri: getCallbackUrl(),
    response_type: "code",
    scope: "openid email profile",
    state
  }).toString();
  return authorizationUrl.toString();
}

export async function authenticateGoogleCode(code: string): Promise<AuthenticatedUser> {
  const callbackUrl = getCallbackUrl();
  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.GOOGLE_CLIENT_ID,
      client_secret: config.GOOGLE_CLIENT_SECRET,
      code,
      grant_type: "authorization_code",
      redirect_uri: callbackUrl
    }),
    signal: AbortSignal.timeout(15_000)
  });

  if (!tokenResponse.ok) {
    throw new Error(`Google token exchange failed with status ${tokenResponse.status}.`);
  }

  const tokenResult = accessTokenSchema.safeParse(await tokenResponse.json());
  if (!tokenResult.success) {
    throw new Error("Google token response was invalid.");
  }

  const profileResponse = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: { authorization: `Bearer ${tokenResult.data.access_token}` },
    signal: AbortSignal.timeout(15_000)
  });
  if (!profileResponse.ok) {
    throw new Error(`Google profile request failed with status ${profileResponse.status}.`);
  }

  const profileResult = googleProfileSchema.safeParse(await profileResponse.json());
  if (!profileResult.success || !profileResult.data.email_verified) {
    throw new Error("Google did not return a verified email address.");
  }

  const email = profileResult.data.email.trim().toLowerCase();
  const profile = profileResult.data;
  const existingGoogleUser = await prisma.user.findUnique({
    where: { googleId: profile.sub },
    select: { id: true }
  });
  const userData = {
    email,
    googleId: profile.sub,
    name: profile.name ?? null,
    avatarUrl: profile.picture ?? null
  };

  if (existingGoogleUser) {
    return prisma.user.update({
      where: { id: existingGoogleUser.id },
      data: userData,
      select: { id: true, email: true, name: true, avatarUrl: true }
    });
  }

  return prisma.user.upsert({
    where: { email },
    create: userData,
    update: {
      googleId: profile.sub,
      name: profile.name ?? undefined,
      avatarUrl: profile.picture ?? undefined
    },
    select: { id: true, email: true, name: true, avatarUrl: true }
  });
}
