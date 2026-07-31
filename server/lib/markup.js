// De costo directo a precio de venta.
//
// El problema que resuelve: si a la IA le pedís "estimá el precio de mercado",
// devuelve lo que sale el material más la mano de obra. Eso es el COSTO DIRECTO.
// Un tipo solo laburando puede presupuestar así y algo le queda; una empresa que
// paga proveedores, sueldos, cargas e impuestos está trabajando gratis.
//
// La cadena que se usa en obra en Argentina:
//
//   costo directo            material + mano de obra
//   + gastos generales       obrador, flete, herramienta, seguros, administración
//   + utilidad               lo que gana la empresa
//   + ingresos brutos        impuesto provincial, se calcula SOBRE LA VENTA
//   + IVA                    si el presupuesto se muestra con IVA
//
// Ojo con ingresos brutos: no es un recargo sobre el costo, es un porcentaje de
// lo que facturás. Sumarle un 3% al costo deja corto — hay que dividir por
// (1 - 0.03) para que después de pagarlo quede el número que querías.

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const pct = (n) => (Number(n) || 0) / 100;

export const DEFAULTS = {
    gastos_pct: 15,
    utilidad_pct: 15,
    iibb_pct: 3,
    iva_pct: 21,
    aplica_iva: 0,
};

/**
 * El número por el que hay que multiplicar el costo directo.
 * Con los valores por defecto da ~1.36: un costo de $600.000 se vende a $818.000.
 */
export function coeficiente(cfg = DEFAULTS) {
    const gg  = pct(cfg.gastos_pct);
    const ut  = pct(cfg.utilidad_pct);
    const ib  = pct(cfg.iibb_pct);
    const iva = cfg.aplica_iva ? pct(cfg.iva_pct) : 0;

    // Un IIBB del 100% o más no tiene sentido y haría explotar la división.
    const divisorIibb = ib >= 0.95 ? 0.05 : 1 - ib;

    const k = (1 + gg) * (1 + ut) / divisorIibb * (1 + iva);
    return Math.round(k * 1e6) / 1e6;
}

/**
 * Desglose de cómo se llega del costo directo al precio final, para mostrárselo
 * y que entienda de dónde sale cada peso.
 */
export function desglose(costoDirecto, cfg = DEFAULTS) {
    const cd  = round2(costoDirecto);
    const gg  = round2(cd * pct(cfg.gastos_pct));
    const sub = round2(cd + gg);
    const ut  = round2(sub * pct(cfg.utilidad_pct));
    const sub2 = round2(sub + ut);

    const ib  = pct(cfg.iibb_pct);
    const divisor = ib >= 0.95 ? 0.05 : 1 - ib;
    const conIibb = round2(sub2 / divisor);
    const iibb = round2(conIibb - sub2);

    const iva = cfg.aplica_iva ? round2(conIibb * pct(cfg.iva_pct)) : 0;
    const total = round2(conIibb + iva);

    return {
        costo_directo: cd,
        gastos_generales: gg,
        utilidad: ut,
        iibb,
        iva,
        total,
        coeficiente: coeficiente(cfg),
        aplica_iva: Boolean(cfg.aplica_iva),
    };
}

/** Lleva un precio unitario de costo directo a precio de venta. */
export function aVenta(precioCosto, cfg = DEFAULTS) {
    return round2((Number(precioCosto) || 0) * coeficiente(cfg));
}

/**
 * Texto para el prompt: qué estructura de costos tiene esta empresa.
 * Es lo que evita que la IA presupueste a costo sin darse cuenta.
 */
export function markupPromptBlock(cfg = DEFAULTS) {
    const k = coeficiente(cfg);
    const partes = [
        `- Gastos generales: ${cfg.gastos_pct}%`,
        `- Utilidad: ${cfg.utilidad_pct}%`,
        `- Ingresos brutos: ${cfg.iibb_pct}% (sobre la venta)`,
        cfg.aplica_iva ? `- IVA: ${cfg.iva_pct}% (los precios se muestran CON IVA)` : `- IVA: no se incluye en los precios`,
    ];

    return `\n\nESTRUCTURA DE COSTOS DE LA EMPRESA (esto NO es un tipo solo con una changa: es una empresa que paga proveedores, sueldos e impuestos):
${partes.join('\n')}
Coeficiente de paso de costo directo a precio de venta: ${k.toFixed(3)}

QUÉ SIGNIFICA PARA VOS:
- Cuando estimás un precio de tu cabeza (o de una búsqueda en internet), lo que estás estimando es el COSTO DIRECTO: lo que sale el material más la mano de obra. NO es el precio de venta.
- Para esos items poné el costo directo en "unit_price" y agregá "es_costo_directo": true. El sistema le aplica el coeficiente y calcula el precio de venta con matemática exacta. VOS NO multipliques por el coeficiente.
- Los precios que salen del TARIFARIO del usuario ya son precios de venta: esos van tal cual, SIN "es_costo_directo".
- En "reply" avisale que sobre el costo se aplicaron gastos generales, utilidad e impuestos, para que sepa de dónde sale el número.`;
}
