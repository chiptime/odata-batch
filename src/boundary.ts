import { randomUUID } from 'crypto';

export const generateBoundaryId = (): string => {
    return randomUUID();
};
