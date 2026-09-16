type RegistrationEnvironment = {
  NODE_ENV?: string;
  PUBLIC_REGISTRATION_ENABLED?: string;
};

export function isPublicRegistrationEnabled(env: RegistrationEnvironment = process.env): boolean {
  if (env.PUBLIC_REGISTRATION_ENABLED === "true") return true;
  if (env.PUBLIC_REGISTRATION_ENABLED === "false") return false;
  return env.NODE_ENV !== "production";
}
