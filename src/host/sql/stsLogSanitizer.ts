export function sanitizeStsLogText(value: unknown, maxLength: number = 2000): string {
	const text = String(value ?? '')
		.replace(/Bearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
		.replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[redacted-jwt]')
		.replace(/([?&](?:access_token|client_secret|code|key|password|sig|signature|token)=)[^&\s]+/gi, '$1[redacted]')
		.replace(/("(?:access_token|azureAccountToken|client_secret|code|key|password|sig|signature|token)"\s*:\s*")[^"]+/gi, '$1[redacted]')
		.replace(/((?:access_token|azureAccountToken|client_secret|password|token)\s*[=:]\s*)[^\s,;]+/gi, '$1[redacted]')
		.replace(/(https?:\/\/)[^/@\s]+@/gi, '$1[redacted]@')
		.trim();
	return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}