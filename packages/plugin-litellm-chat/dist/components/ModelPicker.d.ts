import React from 'react';
export interface ModelPickerProps {
    value: string;
    onChange: (model: string) => void;
    defaultModel?: string | null;
}
export declare const ModelPicker: React.FC<ModelPickerProps>;
