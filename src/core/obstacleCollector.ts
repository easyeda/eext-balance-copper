import type { BBox, Point } from './polygonUtils';

export interface Obstacle {
	points: Point[];
	bbox: BBox;
	type: 'fill' | 'pour' | 'track' | 'pad' | 'via';
}
