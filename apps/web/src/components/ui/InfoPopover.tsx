import { useEffect, useId, useRef, useState, type ReactNode } from "react"

export interface InfoPopoverProps {
	label: string
	children: ReactNode
}

export function InfoPopover({ label, children }: InfoPopoverProps) {
	const [open, setOpen] = useState(false)
	const rootRef = useRef<HTMLSpanElement>(null)
	const panelId = useId()

	useEffect(() => {
		if (!open) return

		const closeOnOutsidePress = (event: PointerEvent) => {
			if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
		}
		const closeOnEscape = (event: KeyboardEvent) => {
			if (event.key === "Escape") setOpen(false)
		}

		document.addEventListener("pointerdown", closeOnOutsidePress)
		document.addEventListener("keydown", closeOnEscape)
		return () => {
			document.removeEventListener("pointerdown", closeOnOutsidePress)
			document.removeEventListener("keydown", closeOnEscape)
		}
	}, [open])

	return (
		<span className="info-popover" ref={rootRef}>
			<button
				type="button"
				className="info-popover__trigger"
				aria-label={`More information: ${label}`}
				aria-expanded={open}
				aria-controls={panelId}
				onClick={() => setOpen((current) => !current)}
			>
				i
			</button>
			{open ? (
				<span className="info-popover__panel" id={panelId} role="note">
					{children}
				</span>
			) : null}
		</span>
	)
}
