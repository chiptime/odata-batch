import { flatten } from '../src/utils';

describe('flatten()', () => {
    describe('handles edge cases', () => {
        test('empty array returns empty array', () => {
            // Arrange
            const input: any[] = [];

            // Act
            const result = flatten(input);

            // Assert
            expect(result).toEqual([]);
        });

        test('single-level array is unchanged', () => {
            // Arrange
            const input = [1, 2, 3];

            // Act
            const result = flatten(input);

            // Assert
            expect(result).toEqual([1, 2, 3]);
        });

        test('nested arrays flatten to one level', () => {
            // Arrange
            const input = [[1], [2, 3]];

            // Act
            const result = flatten(input);

            // Assert
            expect(result).toEqual([1, 2, 3]);
        });

        test('deeply nested arrays flatten by one level only', () => {
            // Arrange
            const input = [[[1, 2]], [[3, 4]]];

            // Act
            const result = flatten(input);

            // Assert
            expect(result).toEqual([
                [1, 2],
                [3, 4],
            ]);
        });

        test('mixed flat and nested values', () => {
            // Arrange
            const input = [1, [2, 3], 4, [5]];

            // Act
            const result = flatten(input);

            // Assert
            expect(result).toEqual([1, 2, 3, 4, 5]);
        });

        test('array with strings and numbers', () => {
            // Arrange
            const input = ['a', ['b', 'c'], 'd'];

            // Act
            const result = flatten(input);

            // Assert
            expect(result).toEqual(['a', 'b', 'c', 'd']);
        });
    });
});
