// Small stroke icon set (24px grid, currentColor). No icon dependency.

const PATHS = {
	home: "M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z",
	send: "M22 2 11 13M22 2l-7 20-4-9-9-4z",
	activity: "M3 12h4l3-8 4 16 3-8h4",
	people:
		"M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75",
	request: "M12 3v12m0 0-5-5m5 5 5-5M5 21h14",
	wallet:
		"M20 12V8H6a2 2 0 0 1 0-4h12v4M4 6v12a2 2 0 0 0 2 2h14v-4M18 12a2 2 0 0 0 0 4h4v-4z",
	card: "M2 7a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2zM2 10h20",
	globe:
		"M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20M2 12h20M12 2a15 15 0 0 1 0 20 15 15 0 0 1 0-20",
	code: "m16 18 6-6-6-6M8 6l-6 6 6 6",
	user: "M20 21a8 8 0 1 0-16 0M12 13a4 4 0 1 0 0-8 4 4 0 0 0 0 8",
	more: "M5 12h.01M12 12h.01M19 12h.01",
	check: "M20 6 9 17l-5-5",
	clock: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20M12 6v6l4 2",
	back: "M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5",
	alert:
		"M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0",
	plus: "M12 5v14M5 12h14",
	arrow: "M5 12h14m-6-6 6 6-6 6",
	sun: "M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10M12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4",
	logout: "M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9",
	shield: "M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10",
	bolt: "M13 2 3 14h9l-1 8 10-12h-9z",
	bank: "M3 21h18M4 18h16M6 18v-7M10 18v-7M14 18v-7M18 18v-7M12 3l9 5H3z",
	phone:
		"M8 2h8a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2M11 18h2",
	search: "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16M21 21l-4.35-4.35",
	refresh: "M21 12a9 9 0 1 1-2.64-6.36L21 8M21 3v5h-5",
	building:
		"M4 21V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v16M16 9h2a2 2 0 0 1 2 2v10M2 21h20M8 7h4M8 11h4M8 15h4",
	chevron: "m9 18 6-6-6-6",
	coin: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20M9 9.5a3 3 0 0 1 3-2 2.5 2.5 0 0 1 0 5 2.5 2.5 0 0 0 0 5 3 3 0 0 0 3-2M12 5.5v2M12 16.5v2",
} as const

export type IconName = keyof typeof PATHS

export function Icon({
	name,
	size = 20,
	className,
}: {
	name: IconName
	size?: number
	className?: string
}) {
	return (
		<svg
			className={className ? `icon ${className}` : "icon"}
			width={size}
			height={size}
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth={2}
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
			focusable="false"
		>
			<path d={PATHS[name]} />
		</svg>
	)
}
