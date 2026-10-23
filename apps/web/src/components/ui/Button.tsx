import { type ButtonHTMLAttributes } from "react"

export type ButtonVariant = "primary" | "secondary" | "ghost"

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
	variant?: ButtonVariant
}

export function Button({
	variant = "primary",
	className,
	type = "button",
	...props
}: ButtonProps) {
	return (
		<button
			type={type}
			className={["button", `button--${variant}`, className]
				.filter(Boolean)
				.join(" ")}
			{...props}
		/>
	)
}
