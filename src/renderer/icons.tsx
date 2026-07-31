import type { SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement>;

const iconDefaults = {
  'aria-hidden': true,
  fill: 'none',
  stroke: 'currentColor',
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  strokeWidth: 1.7,
  viewBox: '0 0 24 24',
};

export const BrandIcon = (props: IconProps) => (
  <svg {...iconDefaults} {...props}>
    <rect x="3.5" y="2.5" width="17" height="19" rx="1" />
    <path d="M8 8h8M8 12h8M8 16h5" />
  </svg>
);

export const DocumentIcon = (props: IconProps) => (
  <svg {...iconDefaults} {...props}>
    <path d="M6 2.75h7l5 5V21H6z" />
    <path d="M13 2.75V8h5M9 12h6M9 16h5" />
  </svg>
);

export const ModelIcon = (props: IconProps) => (
  <svg {...iconDefaults} {...props}>
    <rect x="4" y="5" width="16" height="14" rx="3" />
    <path d="M9 10h.01M15 10h.01M8.5 15h7M12 2v3M2 11h2M20 11h2" />
  </svg>
);

export const AudioFileIcon = (props: IconProps) => (
  <svg {...iconDefaults} {...props}>
    <path d="M5.5 2.75h7l5 5V21h-12z" />
    <path d="M12.5 2.75V8h5M8.5 14v2M11 12.5v5M13.5 11v8M16 14v2" />
  </svg>
);

export const FolderIcon = (props: IconProps) => (
  <svg {...iconDefaults} {...props}>
    <path d="M3 6.75h7l2 2h9v9.75a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5z" />
  </svg>
);

export const MicrophoneIcon = (props: IconProps) => (
  <svg {...iconDefaults} {...props}>
    <rect x="9" y="3" width="6" height="11" rx="3" />
    <path d="M6.5 11.5a5.5 5.5 0 0 0 11 0M12 17v4M9 21h6" />
  </svg>
);

export const InboxIcon = (props: IconProps) => (
  <svg {...iconDefaults} {...props}>
    <path d="m4.5 5.5-2 12.5a2 2 0 0 0 2 2.25h15a2 2 0 0 0 2-2.25l-2-12.5z" />
    <path d="M2.75 15h5l1.5 2h5.5l1.5-2h5" />
  </svg>
);

export const LockIcon = (props: IconProps) => (
  <svg {...iconDefaults} {...props}>
    <rect x="5" y="10" width="14" height="11" rx="2" />
    <path d="M8 10V7a4 4 0 0 1 8 0v3M12 14.5v2.5" />
  </svg>
);

export const SpinnerIcon = (props: IconProps) => (
  <svg {...iconDefaults} {...props}>
    <path d="M20 12a8 8 0 1 1-2.35-5.65" />
  </svg>
);

export const ArrowLeftIcon = (props: IconProps) => (
  <svg {...iconDefaults} {...props}>
    <path d="m15 18-6-6 6-6M9 12h11" />
  </svg>
);

export const DownloadIcon = (props: IconProps) => (
  <svg {...iconDefaults} {...props}>
    <path d="M12 3v12m0 0 4-4m-4 4-4-4M5 20h14" />
  </svg>
);

export const CopyIcon = (props: IconProps) => (
  <svg {...iconDefaults} {...props}>
    <rect x="8" y="8" width="12" height="12" rx="2" />
    <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
  </svg>
);

export const ShareIcon = (props: IconProps) => (
  <svg {...iconDefaults} {...props}>
    <circle cx="18" cy="5" r="2.25" />
    <circle cx="6" cy="12" r="2.25" />
    <circle cx="18" cy="19" r="2.25" />
    <path d="m8 11 8-5M8 13l8 5" />
  </svg>
);

export const TrashIcon = (props: IconProps) => (
  <svg {...iconDefaults} {...props}>
    <path d="M4 7h16M9 7V4h6v3M7 7l1 14h8l1-14M10 11v6M14 11v6" />
  </svg>
);

export const CancelIcon = (props: IconProps) => (
  <svg {...iconDefaults} {...props}>
    <path d="m7 7 10 10M17 7 7 17" />
  </svg>
);
