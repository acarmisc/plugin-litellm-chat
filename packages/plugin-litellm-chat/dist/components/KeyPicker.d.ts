import React from 'react';
export interface KeyPickerProps {
    value: {
        alias: string;
        token: string;
    };
    onChange: (val: {
        alias: string;
        token: string;
    }) => void;
    onDelete?: () => void;
}
export declare const KeyPicker: React.FC<KeyPickerProps>;
