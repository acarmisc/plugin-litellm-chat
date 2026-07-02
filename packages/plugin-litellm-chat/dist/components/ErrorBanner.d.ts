import React from 'react';
export interface ErrorBannerProps {
    error?: string;
    onDismiss?: () => void;
}
export declare const ErrorBanner: React.FC<ErrorBannerProps>;
