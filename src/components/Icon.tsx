import type { SVGProps } from "react";

export type IconName =
  | "bird"
  | "plus"
  | "search"
  | "command"
  | "terminal"
  | "message"
  | "files"
  | "git"
  | "folder"
  | "file"
  | "chevron"
  | "stop"
  | "settings"
  | "bell"
  | "refresh"
  | "close";

interface IconProps extends SVGProps<SVGSVGElement> {
  name: IconName;
  size?: number;
}

const paths: Record<IconName, React.ReactNode> = {
  bird: <><path d="M5 15c4.5.2 7.5-1.5 9-5.5 1.6 1.7 3.2 2.4 5 2.5-1.7 2-3.8 3-6.5 3H9l-2.5 3H4l1-3Z"/><path d="M12.5 9.5c-1.8-2.7-1-5 2-6.5.1 2.1.9 3.8 2.5 5"/></>,
  plus: <><path d="M12 5v14"/><path d="M5 12h14"/></>,
  search: <><circle cx="11" cy="11" r="6"/><path d="m16 16 4 4"/></>,
  command: <><path d="M9 7V5a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3v14a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V7Z"/></>,
  terminal: <><path d="m5 7 4 4-4 4"/><path d="M11 16h7"/></>,
  message: <><path d="M5 5h14v11H9l-4 3V5Z"/></>,
  files: <><path d="M7 3h7l4 4v14H7z"/><path d="M14 3v5h5"/></>,
  git: <><circle cx="7" cy="6" r="2"/><circle cx="17" cy="18" r="2"/><path d="M7 8v7a3 3 0 0 0 3 3h5"/><path d="M7 11h5a3 3 0 0 0 3-3V6"/><circle cx="15" cy="5" r="2"/></>,
  folder: <path d="M3 7h7l2-3h9v16H3z"/>,
  file: <><path d="M6 3h8l4 4v14H6z"/><path d="M14 3v5h5"/></>,
  chevron: <path d="m9 6 6 6-6 6"/>,
  stop: <rect x="6" y="6" width="12" height="12" rx="2"/>,
  settings: <><circle cx="12" cy="12" r="3"/><path d="M19 12a7 7 0 0 0-.1-1l2-1.5-2-3.4-2.5 1A8 8 0 0 0 15 6l-.4-2.7h-4L10 6a8 8 0 0 0-1.5 1l-2.5-1-2 3.4L6.1 11a7 7 0 0 0 0 2L4 14.5 6 18l2.5-1a8 8 0 0 0 1.5 1l.5 2.7h4L15 18a8 8 0 0 0 1.5-1l2.5 1 2-3.4-2.1-1.5a7 7 0 0 0 .1-1Z"/></>,
  bell: <><path d="M18 9a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9Z"/><path d="M10 21h4"/></>,
  refresh: <><path d="M20 11a8 8 0 0 0-14.8-3L3 11"/><path d="M3 5v6h6"/><path d="M4 13a8 8 0 0 0 14.8 3L21 13"/><path d="M21 19v-6h-6"/></>,
  close: <><path d="m6 6 12 12"/><path d="m18 6-12 12"/></>,
};

export function Icon({ name, size = 18, ...props }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      {paths[name]}
    </svg>
  );
}
