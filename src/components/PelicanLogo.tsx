import pelicanLogoUrl from "../../app-icon.svg";

interface PelicanLogoProps {
  className?: string;
  size?: number;
}

export function PelicanLogo({ className, size = 32 }: PelicanLogoProps) {
  return (
    <img
      className={className}
      src={pelicanLogoUrl}
      alt=""
      width={size}
      height={size}
      draggable={false}
    />
  );
}
