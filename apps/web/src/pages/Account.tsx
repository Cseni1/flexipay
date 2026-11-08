import { useCallback, useEffect, useRef, useState, type FormEvent } from "react"
import { Link } from "react-router-dom"
import { AuthRequestError, changePassword } from "../api/auth"
import {
	ApiError,
	createApiKey,
	describeApiError,
	listApiKeys,
	revokeApiKey,
	type ApiKeyRow,
	type CreatedApiKey,
} from "../api/client"
import {
	Button,
	Grid,
	Notice,
	Page,
	PageHeader,
	Panel,
	TextField,
} from "../components/ui"
import { useSession } from "../providers/SessionProvider"

const formatTimestamp = (iso: string): string =>
	new Intl.DateTimeFormat(undefined, {
		dateStyle: "medium",
		timeStyle: "short",
	}).format(new Date(iso))

function SessionRequiredNotice({ forWhat }: { forWhat: string }) {
	return (
		<Notice tone="warning" data-testid="account-session-required">
			{forWhat} needs a signed-in customer account (email session), not the
			local dev proxy key. <Link to="/login">Sign in</Link> with email and
			password.
		</Notice>
	)
}

function ApiKeysPanel({ viaSession }: { viaSession: boolean }) {
	const [keys, setKeys] = useState<ApiKeyRow[]>([])
	const [loading, setLoading] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const [label, setLabel] = useState("")
	const [creating, setCreating] = useState(false)
	const [created, setCreated] = useState<CreatedApiKey | null>(null)
	const [copied, setCopied] = useState(false)
	const [revokeId, setRevokeId] = useState<string | null>(null)
	const [revoking, setRevoking] = useState(false)
	const createLock = useRef(false)

	const refresh = useCallback(async () => {
		if (!viaSession) return
		setLoading(true)
		setError(null)
		try {
			const result = await listApiKeys()
			setKeys(result.keys)
		} catch (cause) {
			setError(
				cause instanceof ApiError
					? describeApiError(cause)
					: "Could not load API keys.",
			)
		} finally {
			setLoading(false)
		}
	}, [viaSession])

	useEffect(() => {
		void refresh()
	}, [refresh])

	const onCreate = async (event: FormEvent) => {
		event.preventDefault()
		if (!viaSession || createLock.current) return
		createLock.current = true
		setCreating(true)
		setError(null)
		setCopied(false)
		try {
			const row = await createApiKey(
				label.trim() ? { label: label.trim() } : {},
			)
			setCreated(row)
			setLabel("")
			await refresh()
		} catch (cause) {
			setError(
				cause instanceof ApiError
					? describeApiError(cause)
					: "Could not create an API key.",
			)
		} finally {
			setCreating(false)
			createLock.current = false
		}
	}

	const copyKey = async () => {
		if (!created) return
		try {
			await navigator.clipboard.writeText(created.key)
			setCopied(true)
		} catch {
			setCopied(false)
		}
	}

	const confirmRevoke = async () => {
		if (!revokeId || revoking) return
		setRevoking(true)
		setError(null)
		try {
			await revokeApiKey(revokeId)
			setRevokeId(null)
			if (created?.id === revokeId) setCreated(null)
			await refresh()
		} catch (cause) {
			setError(
				cause instanceof ApiError
					? describeApiError(cause)
					: "Could not revoke that key.",
			)
		} finally {
			setRevoking(false)
		}
	}

	if (!viaSession) {
		return (
			<Panel
				title="API keys"
				description="Only needed if you connect your own software to FlexiPay."
			>
				<SessionRequiredNotice forWhat="API key management" />
			</Panel>
		)
	}

	return (
		<Panel
			title="API keys"
			description="Keys authenticate server-side calls. The full secret is shown once at create time."
			actions={
				<Button
					type="button"
					variant="secondary"
					onClick={() => void refresh()}
					disabled={loading}
				>
					Refresh
				</Button>
			}
		>
			{error ? (
				<Notice tone="warning" data-testid="api-keys-error">
					{error}
				</Notice>
			) : null}

			{created ? (
				<div className="notice notice--warning" data-testid="api-key-once">
					<p className="form-note">
						<strong>Copy this key now.</strong> It will not be shown again.
					</p>
					<code className="code-text" data-testid="api-key-secret">
						{created.key}
					</code>
					<div className="form-actions">
						<Button
							type="button"
							variant="secondary"
							onClick={() => void copyKey()}
							data-testid="api-key-copy"
						>
							Copy key
						</Button>
						<span className="form-note" role="status">
							{copied ? "Copied" : ""}
						</span>
						<Button
							type="button"
							variant="secondary"
							onClick={() => setCreated(null)}
						>
							Dismiss
						</Button>
					</div>
				</div>
			) : null}

			<form className="form-grid" onSubmit={(event) => void onCreate(event)}>
				<TextField
					label="Key name"
					hint="Optional label shown in the list (max 100 characters)."
					value={label}
					maxLength={100}
					onChange={(event) => setLabel(event.target.value)}
					data-testid="api-key-label"
				/>
				<div className="form-actions">
					<Button
						type="submit"
						disabled={creating}
						data-testid="api-key-create"
					>
						{creating ? "Creating…" : "Create API key"}
					</Button>
				</div>
			</form>

			{loading && keys.length === 0 ? (
				<p className="muted" role="status">
					Loading keys…
				</p>
			) : null}

			{!loading && keys.length === 0 ? (
				<p className="form-note" data-testid="api-keys-empty">
					No API keys yet.
				</p>
			) : (
				<div className="table-scroll">
					<table className="history-table" data-testid="api-keys-table">
						<thead>
							<tr>
								<th scope="col">Name</th>
								<th scope="col">Prefix</th>
								<th scope="col">Created</th>
								<th scope="col">Status</th>
								<th scope="col">Actions</th>
							</tr>
						</thead>
						<tbody>
							{keys.map((row) => {
								const revoked = row.revokedAt !== null
								return (
									<tr key={row.id} data-testid={`api-key-row-${row.id}`}>
										<td>{row.label?.trim() || "Untitled"}</td>
										<td>
											<code className="code-text">{row.prefix}</code>
										</td>
										<td>{formatTimestamp(row.createdAt)}</td>
										<td>{revoked ? "Revoked" : "Active"}</td>
										<td>
											{revoked ? null : revokeId === row.id ? (
												<div
													className="form-actions"
													data-testid="api-key-revoke-confirm"
												>
													<span className="form-note">Revoke this key?</span>
													<Button
														type="button"
														disabled={revoking}
														onClick={() => void confirmRevoke()}
														data-testid="api-key-revoke-yes"
													>
														{revoking ? "Revoking…" : "Revoke"}
													</Button>
													<Button
														type="button"
														variant="secondary"
														disabled={revoking}
														onClick={() => setRevokeId(null)}
													>
														Cancel
													</Button>
												</div>
											) : (
												<Button
													type="button"
													variant="secondary"
													onClick={() => setRevokeId(row.id)}
													data-testid={`api-key-revoke-${row.id}`}
												>
													Revoke
												</Button>
											)}
										</td>
									</tr>
								)
							})}
						</tbody>
					</table>
				</div>
			)}
		</Panel>
	)
}

function ChangePasswordPanel({ viaSession }: { viaSession: boolean }) {
	const [currentPassword, setCurrentPassword] = useState("")
	const [newPassword, setNewPassword] = useState("")
	const [confirmPassword, setConfirmPassword] = useState("")
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const [done, setDone] = useState(false)

	if (!viaSession) {
		return (
			<Panel
				title="Change password"
				description="Update the password for your FlexiPay account."
			>
				<SessionRequiredNotice forWhat="Changing your password" />
			</Panel>
		)
	}

	const onSubmit = (event: FormEvent) => {
		event.preventDefault()
		setError(null)
		setDone(false)
		if (newPassword.length < 10) {
			setError("New password must be at least 10 characters.")
			return
		}
		if (newPassword !== confirmPassword) {
			setError("New password and confirmation do not match.")
			return
		}
		setBusy(true)
		void changePassword({ currentPassword, newPassword })
			.then(() => {
				setCurrentPassword("")
				setNewPassword("")
				setConfirmPassword("")
				setDone(true)
			})
			.catch((cause: unknown) => {
				setError(
					cause instanceof AuthRequestError
						? cause.message
						: "Could not change your password.",
				)
			})
			.finally(() => setBusy(false))
	}

	return (
		<Panel
			title="Change password"
			description="Current password is required. New password must be at least 10 characters."
		>
			<form
				className="form-grid"
				onSubmit={onSubmit}
				data-testid="change-password-form"
			>
				<TextField
					label="Current password"
					type="password"
					autoComplete="current-password"
					required
					value={currentPassword}
					onChange={(event) => setCurrentPassword(event.target.value)}
				/>
				<TextField
					label="New password"
					type="password"
					autoComplete="new-password"
					required
					maxLength={128}
					hint="At least 10 characters."
					value={newPassword}
					onChange={(event) => setNewPassword(event.target.value)}
				/>
				<TextField
					label="Confirm new password"
					type="password"
					autoComplete="new-password"
					required
					maxLength={128}
					value={confirmPassword}
					onChange={(event) => setConfirmPassword(event.target.value)}
				/>
				{error ? (
					<p
						className="form-note"
						role="alert"
						data-testid="change-password-error"
					>
						{error}
					</p>
				) : null}
				{done ? (
					<p
						className="form-note"
						role="status"
						data-testid="change-password-success"
					>
						Password updated.
					</p>
				) : null}
				<div className="form-actions">
					<Button
						type="submit"
						disabled={busy}
						data-testid="change-password-submit"
					>
						{busy ? "Saving…" : "Change password"}
					</Button>
				</div>
			</form>
		</Panel>
	)
}

export default function Account() {
	const { viaSession } = useSession()

	return (
		<Page>
			<PageHeader
				eyebrow="Account"
				title="API keys and account"
				description="Your password, and keys for connecting your own software."
			/>
			<Grid>
				<ApiKeysPanel viaSession={viaSession} />
				<ChangePasswordPanel viaSession={viaSession} />
			</Grid>
		</Page>
	)
}
