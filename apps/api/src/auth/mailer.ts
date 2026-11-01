// TASK 06: transactional email for verification and password reset.
// Production needs a real provider; with none configured, auth fails closed (see config.ts).

export interface MailMessage {
	to: string;
	subject: string;
	text: string;
}

export interface Mailer {
	send(msg: MailMessage): Promise<void>;
}

/** Test/dev mailer that keeps messages in memory. */
export function createMemoryMailer(): Mailer & { outbox: MailMessage[] } {
	const outbox: MailMessage[] = [];
	return {
		outbox,
		async send(msg) {
			outbox.push(msg);
		},
	};
}

/** Dev only: prints the message (it contains a one-time link). Never allowed in production. */
export function createConsoleMailer(): Mailer {
	return {
		async send(msg) {
			console.log(`[mail:dev] to=${msg.to} subject=${msg.subject}\n${msg.text}`);
		},
	};
}

/** Brevo transactional email API (https://api.brevo.com/v3/smtp/email). No SDK; key stays server-side. */
export function createBrevoMailer(
	apiKey: string,
	senderEmail: string,
	senderName = "FlexiPay",
	fetchImpl: typeof fetch = fetch,
): Mailer {
	return {
		async send(msg) {
			const res = await fetchImpl("https://api.brevo.com/v3/smtp/email", {
				method: "POST",
				headers: {
					"api-key": apiKey,
					accept: "application/json",
					"content-type": "application/json",
				},
				body: JSON.stringify({
					sender: { email: senderEmail, name: senderName },
					to: [{ email: msg.to }],
					subject: msg.subject,
					textContent: msg.text,
				}),
			});
			if (!res.ok) {
				// Never include the response body or key in the thrown message.
				throw new Error(`mail provider rejected the message (HTTP ${res.status})`);
			}
		},
	};
}
