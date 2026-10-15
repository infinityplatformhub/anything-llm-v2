function personalAuth(config) {
  return config.anythingllm?.personalAuth ?? { type: "oauth" };
}

function validatePersonalAuth(config) {
  const descriptor = config.anythingllm?.personalAuth;
  if (descriptor === undefined) return;
  if (
    config.anythingllm.perUserAuth !== true ||
    !descriptor ||
    typeof descriptor !== "object" ||
    Array.isArray(descriptor) ||
    !["oauth", "apiKey"].includes(descriptor.type) ||
    Object.keys(descriptor).some(
      (key) =>
        !["type", ...(descriptor.type === "apiKey" ? ["header"] : [])].includes(
          key
        )
    )
  )
    throw new Error("invalid_personal_auth");
  if (descriptor.type === "apiKey") {
    if (
      typeof descriptor.header !== "string" ||
      descriptor.header.toLowerCase() !== "x-api-key" ||
      Object.keys(config.headers || {}).some((key) =>
        /token|key|secret|password|authorization|cookie/i.test(key)
      )
    )
      throw new Error("invalid_personal_auth");
  }
}

function validateApiKey(value) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 4096 ||
    /[^\x20-\x7e]/.test(value) ||
    value !== value.trim()
  )
    throw new Error("invalid_api_key");
  return value;
}

function credentialHeaders(config, credential) {
  const headers = new Headers(config.headers);
  if (personalAuth(config).type === "apiKey") {
    headers.delete("Authorization");
    headers.set("X-API-Key", credential);
  } else headers.set("Authorization", `Bearer ${credential}`);
  return Object.fromEntries(headers);
}

module.exports = {
  personalAuth,
  validatePersonalAuth,
  validateApiKey,
  credentialHeaders,
};
