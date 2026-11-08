import { useState, type FormEvent, type ReactNode } from "react"
import { Link, useNavigate, useSearchParams } from "react-router-dom"
import {
	AuthRequestError,
	requestPasswordReset,
	resendVerification,
	resetPassword,
	signIn,
	signUp,
} from "../api/auth"
import { TextField } from "../components/ui"
import { Icon } from "../components/ui/Icon"
import { useSession } from "../providers/SessionProvider"

// TASK 06: sign-in, registration, email verification and password-reset screens.
// The password only ever travels in the request body of a same-origin call.

function Card({ title, children }: { title: string; children: ReactNode }) {
	return (
		<div className="auth-shell">
			<aside className="auth-side">
				<Link to="/" className="app-brand">
					<span className="app-brand__mark" aria-hidden="true">
						<Icon name="bolt" size={18} />
					</span>
					<span className="app-brand__text">
						<span className="app-brand__name">FlexiPay</span>
						<span className="app-brand__by">by FlexiWork</span>
					</span>
				</Link>
				<div>
					<p className="auth-side__title">
						Send money to any country, in a few taps.
					</p>
					<ul className="auth-side__points">
						{[
							"See the price before you pay",
							"We compare partners for the best deal",
							"Your money stays in your own wallet",
						].map((point) => (
							<li key={point}>
								<span className="auth-side__check">
									<Icon name="check" size={16} />
								</span>
								{point}
							</li>
						))}
					</ul>
				</div>
				<p className="auth-side__foot">FlexiPay is part of FlexiWork.</p>
			</aside>
			<main className="auth-main">
				<div className="auth-card">
					<h1 className="auth-card__title">{title}</h1>
					{children}
				</div>
			</main>
		</div>
	)
}

function useSubmit() {
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const run = async (fn: () => Promise<void>) => {
		setBusy(true)
		setError(null)
		try {
			await fn()
		} catch (e) {
			setError(
				e instanceof AuthRequestError ? e.message : "Something went wrong.",
			)
		} finally {
			setBusy(false)
		}
	}
	return { busy, error, run }
}

export function LoginPage() {
	const { refresh } = useSession()
	const navigate = useNavigate()
	const [params] = useSearchParams()
	const { busy, error, run } = useSubmit()
	const [email, setEmail] = useState("")
	const [password, setPassword] = useState("")
	const [unverified, setUnverified] = useState(false)
	const [resent, setResent] = useState(false)

	const onSubmit = (e: FormEvent) => {
		e.preventDefault()
		setUnverified(false)
		void run(async () => {
			try {
				await signIn({ email, password })
			} catch (err) {
				if (err instanceof AuthRequestError && err.status === 403)
					setUnverified(true)
				throw err
			}
			await refresh()
			void navigate("/", { replace: true })
		})
	}

	return (
		<Card title="Sign in to FlexiPay">
			{params.get("verified") ? (
				<p className="form-note" role="status">
					Email confirmed. You can sign in now.
				</p>
			) : null}
			<form onSubmit={onSubmit} className="form-grid">
				<TextField
					label="Email"
					type="email"
					autoComplete="email"
					required
					value={email}
					onChange={(e) => setEmail(e.target.value)}
				/>
				<TextField
					label="Password"
					type="password"
					autoComplete="current-password"
					required
					value={password}
					onChange={(e) => setPassword(e.target.value)}
				/>
				{error ? (
					<p className="form-note" role="alert">
						{error}
					</p>
				) : null}
				{unverified ? (
					<p className="form-note">
						Confirm your email first.{" "}
						<button
							type="button"
							disabled={resent}
							onClick={() =>
								void resendVerification(email)
									.then(() => setResent(true))
									.catch(() => undefined)
							}
						>
							{resent ? "Sent" : "Resend the email"}
						</button>
					</p>
				) : null}
				<div className="form-actions">
					<button
						type="submit"
						className="button button--primary auth-card__submit"
						disabled={busy}
					>
						{busy ? "Signing in..." : "Sign in"}
					</button>
				</div>
			</form>
			<p className="form-note">
				<Link to="/forgot-password">Forgot your password?</Link> {" | "}
				<Link to="/register">Create an account</Link>
			</p>
		</Card>
	)
}

export function RegisterPage() {
	const { busy, error, run } = useSubmit()
	const [name, setName] = useState("")
	const [email, setEmail] = useState("")
	const [password, setPassword] = useState("")
	const [done, setDone] = useState(false)

	if (done)
		return (
			<Card title="Check your email">
				<p className="form-note" role="status">
					We sent a confirmation link to {email}. Open it, then{" "}
					<Link to="/login">sign in</Link>.
				</p>
			</Card>
		)

	return (
		<Card title="Create your FlexiPay account">
			<form
				className="form-grid"
				onSubmit={(e) => {
					e.preventDefault()
					void run(async () => {
						await signUp({ name, email, password })
						setDone(true)
					})
				}}
			>
				<TextField
					label="Name"
					autoComplete="name"
					required
					value={name}
					onChange={(e) => setName(e.target.value)}
				/>
				<TextField
					label="Email"
					type="email"
					autoComplete="email"
					required
					value={email}
					onChange={(e) => setEmail(e.target.value)}
				/>
				<TextField
					label="Password"
					type="password"
					autoComplete="new-password"
					required
					minLength={10}
					maxLength={128}
					hint="At least 10 characters."
					value={password}
					onChange={(e) => setPassword(e.target.value)}
				/>
				{error ? (
					<p className="form-note" role="alert">
						{error}
					</p>
				) : null}
				<div className="form-actions">
					<button
						type="submit"
						className="button button--primary auth-card__submit"
						disabled={busy}
					>
						{busy ? "Creating..." : "Create account"}
					</button>
				</div>
			</form>
			<p className="form-note">
				Already registered? <Link to="/login">Sign in</Link>
			</p>
		</Card>
	)
}

export function ForgotPasswordPage() {
	const { busy, error, run } = useSubmit()
	const [email, setEmail] = useState("")
	const [sent, setSent] = useState(false)
	return (
		<Card title="Reset your password">
			{sent ? (
				<p className="form-note" role="status">
					If an account exists for {email}, a reset link is on its way.
				</p>
			) : (
				<form
					className="form-grid"
					onSubmit={(e) => {
						e.preventDefault()
						void run(async () => {
							await requestPasswordReset(email)
							setSent(true)
						})
					}}
				>
					<TextField
						label="Email"
						type="email"
						autoComplete="email"
						required
						value={email}
						onChange={(e) => setEmail(e.target.value)}
					/>
					{error ? (
						<p className="form-note" role="alert">
							{error}
						</p>
					) : null}
					<div className="form-actions">
						<button
							type="submit"
							className="button button--primary auth-card__submit"
							disabled={busy}
						>
							Send reset link
						</button>
					</div>
				</form>
			)}
			<p className="form-note">
				<Link to="/login">Back to sign in</Link>
			</p>
		</Card>
	)
}

export function ResetPasswordPage() {
	const [params] = useSearchParams()
	const token = params.get("token")
	const { busy, error, run } = useSubmit()
	const [password, setPassword] = useState("")
	const [done, setDone] = useState(false)

	if (!token || params.get("error"))
		return (
			<Card title="Reset link not valid">
				<p className="form-note" role="alert">
					This link is invalid or has expired.{" "}
					<Link to="/forgot-password">Request a new one</Link>.
				</p>
			</Card>
		)
	if (done)
		return (
			<Card title="Password changed">
				<p className="form-note" role="status">
					You were signed out everywhere.{" "}
					<Link to="/login">Sign in with the new password</Link>.
				</p>
			</Card>
		)
	return (
		<Card title="Choose a new password">
			<form
				className="form-grid"
				onSubmit={(e) => {
					e.preventDefault()
					void run(async () => {
						await resetPassword({ token, newPassword: password })
						setDone(true)
					})
				}}
			>
				<TextField
					label="New password"
					type="password"
					autoComplete="new-password"
					required
					minLength={10}
					maxLength={128}
					value={password}
					onChange={(e) => setPassword(e.target.value)}
				/>
				{error ? (
					<p className="form-note" role="alert">
						{error}
					</p>
				) : null}
				<div className="form-actions">
					<button
						type="submit"
						className="button button--primary auth-card__submit"
						disabled={busy}
					>
						Change password
					</button>
				</div>
			</form>
		</Card>
	)
}
