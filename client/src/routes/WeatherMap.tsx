import * as React from 'react';
import { Loading } from '@/components/Misc';

/**
 * The snow map, loaded on first visit: MapLibre and its worker are most of a
 * megabyte that nobody who never opens the map should download.
 */
const StormMap = React.lazy(() => import('./weatherMap/StormMap'));

export function WeatherMap(): JSX.Element {
  return (
    <React.Suspense fallback={<Loading />}>
      <StormMap />
    </React.Suspense>
  );
}
