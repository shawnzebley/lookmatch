// Keep reference-matched tonal targets intact when Auto Adjust is requested.
export function hasReferenceCurve(params = {}) {
  return params.curveAuto === 'reference' ||
    ['subject', 'background'].some((region) => params.local?.[region]?.curveAuto === 'reference');
}

export function autoAdjustResult(params = {}, calculated = {}) {
  return hasReferenceCurve(params)
    ? { ...params, preservedReference: true }
    : { ...calculated, preservedReference: false };
}
