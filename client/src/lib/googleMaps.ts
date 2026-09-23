/**
 * Loads the Google Maps script once, with the key the server hands out.
 * The key is a browser key by design; what keeps it from being abused is the
 * domain and API restrictions set on it in Google Cloud.
 */

let loading: Promise<typeof google.maps> | null = null;

export function loadGoogleMaps(apiKey: string): Promise<typeof google.maps> {
  if (window.google?.maps) return Promise.resolve(window.google.maps);

  loading ??= new Promise((resolve, reject) => {
    const callback = `__driftMapsReady${Date.now()}`;
    (window as unknown as Record<string, () => void>)[callback] = () => resolve(window.google.maps);

    const script = document.createElement('script');
    script.src =
      `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(apiKey)}` +
      `&v=weekly&callback=${callback}`;
    script.async = true;
    script.onerror = () => {
      loading = null;
      reject(new Error('Google Maps could not be loaded. Check the connection and the API key.'));
    };
    document.head.appendChild(script);
  });

  return loading;
}

export interface GeocodedAddress {
  address_line1: string | null;
  city: string | null;
  province: string | null;
  postal_code: string | null;
  /** The whole thing, for showing the rep what the map thinks this is. */
  formatted: string | null;
}

/** What is at this spot, as best the map can tell. Parts can be missing. */
export async function addressAt(
  maps: typeof google.maps,
  position: google.maps.LatLngLiteral,
): Promise<GeocodedAddress> {
  const empty: GeocodedAddress = {
    address_line1: null,
    city: null,
    province: null,
    postal_code: null,
    formatted: null,
  };
  try {
    const { results } = await new maps.Geocoder().geocode({ location: position });
    // The most specific answer: a street address beats a neighbourhood.
    const best =
      results.find((r) => r.types.includes('street_address') || r.types.includes('premise')) ??
      results[0];
    if (!best) return empty;

    const part = (type: string, short = false): string | null => {
      const c = best.address_components.find((x) => x.types.includes(type));
      return c ? (short ? c.short_name : c.long_name) : null;
    };
    const number = part('street_number');
    const street = part('route');

    return {
      address_line1: number && street ? `${number} ${street}` : street,
      city: part('locality') ?? part('postal_town') ?? part('sublocality') ?? part('administrative_area_level_3'),
      province: part('administrative_area_level_1', true),
      postal_code: part('postal_code'),
      formatted: best.formatted_address ?? null,
    };
  } catch {
    // No address is still a pin; the rep can type it in at sign-up.
    return empty;
  }
}
