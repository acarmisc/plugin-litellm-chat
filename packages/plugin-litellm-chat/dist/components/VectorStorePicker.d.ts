import React from 'react';
export interface VectorStorePickerProps {
    value: string | null;
    onChange: (id: string | null) => void;
    defaultVectorStoreId?: string | null;
}
export declare const VectorStorePicker: React.FC<VectorStorePickerProps>;
