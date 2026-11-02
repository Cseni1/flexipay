import QRCode from "qrcode"
import { useEffect, useState } from "react"

type Props = {
	value: string
	label?: string
	size?: number
}

/** Renders a QR for a real payload (wallet address / Solana Pay URI). No placeholder data. */
export function QrCode({ value, label = "QR code", size = 180 }: Props) {
	const [dataUrl, setDataUrl] = useState<string | null>(null)
	const [error, setError] = useState<string | null>(null)

	useEffect(() => {
		let cancelled = false
		setDataUrl(null)
		setError(null)
		if (!value) return
		void QRCode.toDataURL(value, {
			width: size,
			margin: 1,
			color: { dark: "#111a2b", light: "#ffffff" },
		})
			.then((url) => {
				if (!cancelled) setDataUrl(url)
			})
			.catch(() => {
				if (!cancelled) setError("Could not render QR code.")
			})
		return () => {
			cancelled = true
		}
	}, [value, size])

	if (error) {
		return (
			<p className="form-note" role="status">
				{error}
			</p>
		)
	}
	if (!dataUrl) {
		return (
			<p className="form-note" role="status">
				Preparing QR…
			</p>
		)
	}
	return (
		<img
			className="qr-code"
			src={dataUrl}
			width={size}
			height={size}
			alt={label}
			data-testid="receive-qr"
		/>
	)
}
