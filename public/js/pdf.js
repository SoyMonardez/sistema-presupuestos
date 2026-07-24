// Export a PDF — dos formatos: "original" (Etan Construcción, color) y "municipal" (blanco y negro, formal).
// Datos del emisor — editá estos valores si cambian:
const PDF_EMISOR = {
    nombre: 'ETAN CONSTRUCCIÓN',
    subtitulo: 'Cómputo y Presupuesto Oficial de Mano de Obra',
    telefono: '+54 9 264 570-0122',
    telefonoCorto: '264 5700122',
    origen: 'San Juan, Argentina',
    ciudad: 'San Juan, Capital',
    firma: 'Etan Construcción',
    // Datos legales para el formato municipal (cabecera formal):
    nombreLegal: 'MONARDEZ ALEJO SAMUEL',
    cuit: '20-47815371-7',
    direccion: 'Nacional y Misiones, Albardón',
    telefonoMunicipal: '264 570 0122',
    email: '',
};

// Paleta del documento original
const NAVY       = [23, 55, 94];     // títulos, encabezado de tabla
const NAVY_SOFT  = [31, 78, 121];    // texto de labels
const GRAY_TEXT  = [110, 110, 110];
const LIGHT_BLUE = [222, 235, 247];  // fila de adelanto
const BOX_BG     = [244, 246, 250];  // caja de datos cliente/obra
const STRIPE_BG  = [249, 250, 252];  // striping de la tabla

// Formato del documento original: $ 11,465,000.00 (estilo en-US)
function moneyUS(value) {
    return '$ ' + (Number(value) || 0).toLocaleString('en-US', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    });
}

function qtyUS(value) {
    return (Number(value) || 0).toLocaleString('en-US', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    });
}

function longDateAR(date) {
    const months = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
    return `${date.getDate()} de ${months[date.getMonth()]}, ${date.getFullYear()}`;
}

// Formato peso estilo es-AR para el documento municipal: $ 6.960.490,00
function moneyAR(value) {
    return '$ ' + (Number(value) || 0).toLocaleString('es-AR', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    });
}

function qtyAR(value) {
    return (Number(value) || 0).toLocaleString('es-AR', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    });
}

function pctAR(value) {
    return (Number(value) || 0).toLocaleString('es-AR', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    }) + '%';
}

function shortDateAR(date) {
    return date.toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

// ===== Número a letras (español, montos en pesos) =====
const _ESPECIALES = ['CERO','UNO','DOS','TRES','CUATRO','CINCO','SEIS','SIETE','OCHO','NUEVE','DIEZ','ONCE','DOCE','TRECE','CATORCE','QUINCE','DIECISÉIS','DIECISIETE','DIECIOCHO','DIECINUEVE','VEINTE','VEINTIUNO','VEINTIDÓS','VEINTITRÉS','VEINTICUATRO','VEINTICINCO','VEINTISÉIS','VEINTISIETE','VEINTIOCHO','VEINTINUEVE'];
const _DECENAS   = ['','','','TREINTA','CUARENTA','CINCUENTA','SESENTA','SETENTA','OCHENTA','NOVENTA'];
const _CENTENAS  = ['','CIENTO','DOSCIENTOS','TRESCIENTOS','CUATROCIENTOS','QUINIENTOS','SEISCIENTOS','SETECIENTOS','OCHOCIENTOS','NOVECIENTOS'];

function _seccion(n) { // 0..999
    if (n === 100) return 'CIEN';
    let out = '';
    const c = Math.floor(n / 100);
    const d = n % 100;
    if (c) out += _CENTENAS[c] + ' ';
    if (d <= 29) {
        if (d) out += _ESPECIALES[d];
    } else {
        const dec = Math.floor(d / 10);
        const u = d % 10;
        out += _DECENAS[dec];
        if (u) out += ' Y ' + _ESPECIALES[u];
    }
    return out.trim();
}

// "UNO" → "UN", "VEINTIUNO" → "VEINTIÚN" cuando precede a mil/millón
function _apocope(str) {
    if (str.endsWith('VEINTIUNO')) return str.slice(0, -9) + 'VEINTIÚN';
    if (str.endsWith('UNO')) return str.slice(0, -3) + 'UN';
    return str;
}

function numeroALetras(num) {
    num = Math.floor(Math.abs(Number(num) || 0));
    if (num === 0) return 'CERO';
    if (num < 1000) return _seccion(num);
    if (num < 1000000) {
        const miles = Math.floor(num / 1000);
        const resto = num % 1000;
        const prefix = miles === 1 ? 'MIL' : _apocope(_seccion(miles)) + ' MIL';
        return (prefix + (resto ? ' ' + numeroALetras(resto) : '')).trim();
    }
    if (num < 1000000000000) {
        const mill = Math.floor(num / 1000000);
        const resto = num % 1000000;
        const prefix = mill === 1 ? 'UN MILLÓN' : _apocope(numeroALetras(mill)) + ' MILLONES';
        return (prefix + (resto ? ' ' + numeroALetras(resto) : '')).trim();
    }
    return String(num); // fuera de rango razonable
}

// "SETENTA Y SIETE MILLONES ... CON 44/100.-"
function montoEnLetras(value) {
    const v = Number(value) || 0;
    const entero = Math.floor(v);
    const centavos = Math.round((v - entero) * 100);
    return `${numeroALetras(entero)} CON ${String(centavos).padStart(2, '0')}/100.-`;
}

// Nombre de archivo seguro a partir del nombre de la obra
function pdfFileName(budget) {
    const safeName = (budget.name || 'presupuesto')
        .toLowerCase()
        .normalize('NFD')
        .split('').filter(c => c.charCodeAt(0) < 0x300 || c.charCodeAt(0) > 0x36f).join('')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '');
    const fileDate = new Date().toISOString().slice(0, 10);
    return `presupuesto-${safeName}-${fileDate}.pdf`;
}

// Dispatcher: elige el formato según budget.format
function exportBudgetPDF(budget, items) {
    if (budget.format === 'municipal') return exportMunicipalPDF(budget, items);
    return exportOriginalPDF(budget, items);
}

function exportOriginalPDF(budget, items) {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: 'mm', format: 'a4' });
    const pageWidth = doc.internal.pageSize.getWidth();
    const pageHeight = doc.internal.pageSize.getHeight();
    const margin = 16;
    const contentW = pageWidth - margin * 2;

    const total = items.reduce((sum, i) => sum + i.quantity * i.unit_price, 0);
    const advancePct = Number(budget.advance_pct) || 0;
    const advance = total * advancePct / 100;
    const balance = total - advance;
    const validityDays = Number(budget.validity_days) || 10;

    // ================= Encabezado =================
    let y = 18;
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(13);
    doc.setTextColor(...NAVY);
    doc.text(PDF_EMISOR.nombre, margin, y);

    y += 10;
    doc.setFontSize(26);
    doc.text('PRESUPUESTO', margin, y);

    y += 7;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9.5);
    doc.setTextColor(...GRAY_TEXT);
    doc.text(PDF_EMISOR.subtitulo, margin, y);

    // Bloque derecho: pares label/valor alineados a la derecha
    const rightPairs = [
        ['Fecha de Emisión:', longDateAR(new Date())],
        ['Validez de Oferta:', `${validityDays} días corridos`],
        ['Contacto Celular:', PDF_EMISOR.telefono],
        ['Origen:', PDF_EMISOR.origen],
    ];
    let ry = 17;
    doc.setFontSize(8.5);
    for (const [label, value] of rightPairs) {
        doc.setFont('helvetica', 'normal');
        doc.setTextColor(60);
        const valueW = doc.getTextWidth(' ' + value);
        doc.text(value, pageWidth - margin, ry, { align: 'right' });
        doc.setFont('helvetica', 'bold');
        doc.setTextColor(...NAVY_SOFT);
        doc.text(label, pageWidth - margin - valueW, ry, { align: 'right' });
        ry += 5;
    }

    // Línea azul gruesa bajo el encabezado
    y += 5;
    doc.setDrawColor(...NAVY);
    doc.setLineWidth(1.1);
    doc.line(margin, y, pageWidth - margin, y);

    // ================= Caja cliente / obra =================
    y += 6;
    const boxH = 22;
    doc.setFillColor(...BOX_BG);
    doc.setDrawColor(225, 228, 235);
    doc.setLineWidth(0.3);
    doc.rect(margin, y, contentW, boxH, 'FD');

    const col1Label = margin + 4;
    const col1Value = margin + 26;
    const col2Label = margin + contentW / 2 + 4;
    const col2Value = margin + contentW / 2 + 28;
    const boxRow1 = y + 8;
    const boxRow2 = y + 16;

    doc.setFontSize(9.5);
    function boxPair(lx, vx, by, label, value, maxW) {
        doc.setFont('helvetica', 'bold');
        doc.setTextColor(...NAVY_SOFT);
        doc.text(label, lx, by);
        doc.setFont('helvetica', 'normal');
        doc.setTextColor(50);
        const lines = doc.splitTextToSize(value || '—', maxW);
        doc.text(lines.slice(0, 2), vx, by);
    }
    const valW1 = contentW / 2 - 28;
    boxPair(col1Label, col1Value, boxRow1, 'Cliente:',   budget.client, valW1);
    boxPair(col1Label, col1Value, boxRow2, 'Obra:',      budget.name, valW1);
    boxPair(col2Label, col2Value, boxRow1, 'Ubicación:', budget.location, valW1);
    boxPair(col2Label, col2Value, boxRow2, 'Moneda:',    'Pesos Argentinos ($)', valW1);

    y += boxH + 8;

    // ================= Tabla de items =================
    // Cada item ocupa 1 o 2 filas (título + detalles en viñetas) agrupadas con rowSpan.
    const body = [];
    const itemRowMap = []; // índice de fila → índice de item (para striping por grupo)
    items.forEach((item, idx) => {
        const hasDetail = Boolean(item.detail && item.detail.trim());
        const span = hasDetail ? 2 : 1;
        body.push([
            { content: String(idx + 1), rowSpan: span, styles: { halign: 'center', valign: 'top', fontStyle: 'bold', textColor: NAVY_SOFT } },
            { content: item.name, styles: { fontStyle: 'bold', textColor: NAVY_SOFT } },
            { content: qtyUS(item.quantity), rowSpan: span, styles: { halign: 'right', valign: 'top' } },
            { content: item.unit, rowSpan: span, styles: { halign: 'center', valign: 'top', textColor: GRAY_TEXT } },
            { content: moneyUS(item.unit_price), rowSpan: span, styles: { halign: 'right', valign: 'top' } },
            { content: moneyUS(item.quantity * item.unit_price), rowSpan: span, styles: { halign: 'right', valign: 'top' } },
        ]);
        itemRowMap.push(idx);
        if (hasDetail) {
            const bullets = item.detail.trim().split('\n').map(l => l.trim()).filter(Boolean)
                .map(l => '• ' + l).join('\n');
            body.push([
                { content: bullets, styles: { fontSize: 7.5, textColor: GRAY_TEXT, cellPadding: { top: 0.5, bottom: 2.5, left: 2.5, right: 2 } } },
            ]);
            itemRowMap.push(idx);
        }
    });

    doc.autoTable({
        startY: y,
        margin: { left: margin, right: margin, bottom: 18 },
        head: [['ÍTEM', 'DESCRIPCIÓN DE TAREAS / RUBROS DE OBRA', 'CANT.', 'UNID.', 'P. UNITARIO', 'P. TOTAL']],
        body,
        theme: 'grid',
        styles: {
            fontSize: 8.5,
            cellPadding: 2.5,
            lineColor: [225, 228, 235],
            lineWidth: 0.2,
            textColor: [50, 50, 50],
        },
        headStyles: {
            fillColor: NAVY,
            textColor: 255,
            fontStyle: 'bold',
            fontSize: 8,
            halign: 'left',
        },
        columnStyles: {
            0: { cellWidth: 12, halign: 'center' },
            1: { cellWidth: 'auto' },
            2: { cellWidth: 16, halign: 'right' },
            3: { cellWidth: 14, halign: 'center' },
            4: { cellWidth: 26, halign: 'right' },
            5: { cellWidth: 28, halign: 'right' },
        },
        didParseCell(data) {
            if (data.section === 'head') {
                if (data.column.index === 0 || data.column.index === 3) data.cell.styles.halign = 'center';
                if (data.column.index === 2 || data.column.index >= 4) data.cell.styles.halign = 'right';
            }
            if (data.section === 'body') {
                // Striping por item (las 2 filas del grupo comparten color)
                const itemIdx = itemRowMap[data.row.index];
                data.cell.styles.fillColor = (itemIdx % 2 === 1) ? STRIPE_BG : [255, 255, 255];
            }
        },
    });

    // ================= Totales =================
    let ty = doc.lastAutoTable.finalY + 8;
    const totalsW = 92;
    const totalsX = pageWidth - margin - totalsW;
    const rowH = 7.5;
    const showAdvance = advancePct > 0;
    const totalsBlockH = (showAdvance ? rowH * 3 : rowH) + 11;

    if (ty + totalsBlockH > pageHeight - 24) {
        doc.addPage();
        ty = 22;
    }

    doc.setFontSize(9.5);
    function totalsRow(label, value, opts = {}) {
        if (opts.fill) {
            doc.setFillColor(...opts.fill);
            doc.rect(totalsX, ty - 5, totalsW, rowH, 'F');
        }
        doc.setFont('helvetica', opts.italic ? 'italic' : 'bold');
        doc.setTextColor(...(opts.labelColor || [50, 50, 50]));
        doc.text(label, totalsX + 3, ty);
        doc.setTextColor(...(opts.valueColor || [50, 50, 50]));
        doc.text(value, totalsX + totalsW - 3, ty, { align: 'right' });
        ty += rowH;
    }

    totalsRow('Subtotal Obra:', moneyUS(total));
    if (showAdvance) {
        totalsRow(`Adelanto Requerido (${advancePct}%):`, moneyUS(advance), { fill: LIGHT_BLUE, labelColor: NAVY_SOFT, valueColor: NAVY_SOFT });
        totalsRow(`Saldo Financiero (${100 - advancePct}%):`, moneyUS(balance), { italic: true, labelColor: GRAY_TEXT, valueColor: GRAY_TEXT });
    }

    // TOTAL GENERAL: caja navy con sección más oscura para el monto
    ty += 1;
    const tgH = 10;
    doc.setFillColor(...NAVY_SOFT);
    doc.rect(totalsX, ty - 6, totalsW, tgH, 'F');
    doc.setFillColor(...NAVY);
    doc.rect(totalsX + totalsW * 0.42, ty - 6, totalsW * 0.58, tgH, 'F');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10.5);
    doc.setTextColor(255);
    doc.text('TOTAL GENERAL', totalsX + 3, ty + 0.5);
    doc.text(moneyUS(total), totalsX + totalsW - 3, ty + 0.5, { align: 'right' });
    ty += tgH + 4;

    // ================= Términos y condiciones =================
    doc.setDrawColor(200);
    doc.setLineWidth(0.2);
    doc.setLineDashPattern([1, 1], 0);
    doc.line(margin, ty, pageWidth - margin, ty);
    doc.setLineDashPattern([], 0);
    ty += 8;

    const terms = [];
    if (showAdvance) {
        terms.push(`Condición de Inicio: Se establece de forma obligatoria un Adelanto de Obra del ${advancePct}% sobre el total presupuestado, equivalente a ${moneyUS(advance)}, el cual deberá hacerse efectivo para la reserva de la fecha de inicio y movilización de operarios.`);
        terms.push(`Financiación del Saldo: El ${100 - advancePct}% restante se abonará mediante certificaciones periódicas de avance de obra o según común acuerdo previo al inicio de los trabajos estructurales.`);
    }
    terms.push(`El presente documento formalizado por ${PDF_EMISOR.firma} cuenta con validez legal de oferta por ${validityDays} días en la localidad de ${PDF_EMISOR.ciudad}.`);
    if (budget.notes && budget.notes.trim()) {
        for (const line of budget.notes.trim().split('\n').map(l => l.trim()).filter(Boolean)) {
            terms.push(line);
        }
    }

    const termsH = 8 + terms.length * 10;
    if (ty + termsH + 35 > pageHeight - 15) {
        doc.addPage();
        ty = 22;
    }

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10);
    doc.setTextColor(...NAVY);
    doc.text('TÉRMINOS CONTRACTUALES Y CONDICIONES DE PAGO', margin, ty);
    ty += 6;

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8.5);
    doc.setTextColor(60);
    terms.forEach((term, i) => {
        const lines = doc.splitTextToSize(`${i + 1}. ${term}`, contentW);
        doc.text(lines, margin, ty);
        ty += lines.length * 4 + 2;
    });

    // ================= Firma =================
    let sy = ty + 22;
    if (sy > pageHeight - 20) {
        doc.addPage();
        sy = 50;
    }
    const sigW = 55;
    const sigX = pageWidth - margin - sigW;
    doc.setDrawColor(120);
    doc.setLineWidth(0.3);
    doc.line(sigX, sy, pageWidth - margin, sy);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9);
    doc.setTextColor(...NAVY_SOFT);
    doc.text(PDF_EMISOR.firma, pageWidth - margin, sy + 5, { align: 'right' });
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(...GRAY_TEXT);
    doc.text(`Contacto: ${PDF_EMISOR.telefonoCorto}`, pageWidth - margin, sy + 9.5, { align: 'right' });
    doc.text(PDF_EMISOR.ciudad, pageWidth - margin, sy + 13.5, { align: 'right' });

    // ================= Guardar =================
    doc.save(pdfFileName(budget));
}

// ===================================================================
// FORMATO MUNICIPAL — réplica fiel del presupuesto formal (blanco y negro,
// HORIZONTAL / apaisado). Coordenadas en puntos extraídas del modelo real
// (Plaza Juventudes). Página A4 landscape = 842 x 595 pt.
// ===================================================================
function exportMunicipalPDF(budget, items) {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: 'pt', format: 'a4', orientation: 'landscape' });
    const PAGE_H = 595;

    const total = items.reduce((sum, i) => sum + i.quantity * i.unit_price, 0);

    doc.setTextColor(0);
    doc.setDrawColor(0);
    doc.setLineWidth(0.7);

    // --- Columnas verticales de la grilla (X) ---
    const L = 43, NUM_R = 71.6, DESC_R = 405.4, UNIT_R = 463.1,
          QTY_R = 536.6, PU_R = 629.6, PI_R = 737.6, R = 800;
    const ROW_H = 21.8, LINE_H = 10;

    // --- helpers ---
    const ln = (x0, y0, x1, y1) => doc.line(x0, y0, x1, y1);
    const box = (x0, y0, x1, y1) => doc.rect(x0, y0, x1 - x0, y1 - y0);
    function T(txt, x, y, { b = false, align = 'left', size = 8.5, maxW = 0, cs = 0 } = {}) {
        txt = String(txt ?? '');
        doc.setFont('helvetica', b ? 'bold' : 'normal');
        if (cs) doc.setCharSpace(cs);
        let s = size;
        doc.setFontSize(s);
        if (maxW) { while (s > 5.5 && doc.getTextWidth(txt) > maxW) { s -= 0.5; doc.setFontSize(s); } }
        doc.text(txt, x, y, { baseline: 'top', align });
        if (cs) doc.setCharSpace(0);
    }

    // ===== Caja PRESUPUESTO + Fecha / Precio Total =====
    box(611.4, 34.7, R, 62);
    T('PRESUPUESTO', (611.4 + R) / 2, 36.5, { b: true, size: 13, align: 'center', cs: 1.9 });
    T('Fecha:', 609, 68.8);
    T(shortDateAR(new Date()), R, 68.8, { b: true, align: 'right' });
    T('Precio Total:', 609, 83.8);
    T(moneyAR(total), R, 83.8, { b: true, align: 'right' });

    // ===== Cabecera EMPRESA / CLIENTE =====
    T('EMPRESA', 44.2, 111.3, { b: true, size: 8 });
    T('CLIENTE', 428.6, 111.3, { b: true, size: 8 });
    box(L, 122, 416, 222.8);      // caja EMPRESA
    box(427.7, 122, R, 222.8);    // caja CLIENTE

    const ROWS_Y = [131.1, 146.1, 160.3, 174.6, 188.8, 203.8];
    const empPairs = [
        ['Nombre:',    PDF_EMISOR.nombreLegal],
        ['Cuit:',      PDF_EMISOR.cuit],
        ['Dirección:', PDF_EMISOR.direccion],
        ['Teléfono:',  PDF_EMISOR.telefonoMunicipal],
        ['Email:',     PDF_EMISOR.email],
    ];
    empPairs.forEach(([l, v], i) => {
        T(l, 51, ROWS_Y[i], { b: true });
        T(v, 155.5, ROWS_Y[i], { maxW: 416 - 155.5 - 4 });
    });

    const cliPairs = [
        ['Nombre:',        budget.client],
        ['Intendente:',    budget.client_role],
        ['Dirección:',     budget.client_address],
        ['Código Postal:', budget.client_cp],
        ['Teléfono:',      budget.client_phone],
        ['Email:',         budget.client_email],
    ];
    cliPairs.forEach(([l, v], i) => {
        T(l, 435.4, ROWS_Y[i], { b: true });
        T(v, 555.7, ROWS_Y[i], { maxW: R - 555.7 - 4 });
    });

    // ===== OBRA =====
    box(L, 234, R, 260.2);
    ln(96, 234, 96, 260.2); // divisor OBRA: | descripción
    T('OBRA:', 51, 242, { b: true, size: 9 });
    T((budget.name || ''), 229, 241, { b: true, size: 9.5, maxW: R - 229 - 6 });

    // ===== Tabla: encabezado =====
    const HEAD_TOP = 271.5, HEAD_BOTTOM = 305.2;
    // columnas: las divisorias verticales del cuerpo (incluye Nº)
    const bodyVx = [L, NUM_R, DESC_R, UNIT_R, QTY_R, PU_R, PI_R, R];
    // en el encabezado el Nº no tiene divisoria propia salvo NUM_R
    function drawTableHead(top) {
        const bottom = top + (HEAD_BOTTOM - HEAD_TOP);
        ln(L, top, R, top);
        ln(L, bottom, R, bottom);
        bodyVx.forEach(x => ln(x, top, x, bottom));
        const hy = top + 10;
        T('DESCRIPCIÓN',  (NUM_R + DESC_R) / 2, hy, { b: true, align: 'center' });
        T('UNIDAD',       (DESC_R + UNIT_R) / 2, hy, { b: true, align: 'center' });
        T('CANTIDAD',     (UNIT_R + QTY_R) / 2,  hy, { b: true, align: 'center' });
        T('PRECIO UNIT',  (QTY_R + PU_R) / 2,    hy, { b: true, align: 'center' });
        T('PRECIO ITEMS', (PU_R + PI_R) / 2,     hy, { b: true, align: 'center' });
        // % INCIDENCIA en dos líneas
        T('%',          (PI_R + R) / 2, top + 5,  { b: true, align: 'center' });
        T('INCIDENCIA', (PI_R + R) / 2, top + 16, { b: true, align: 'center' });
        return bottom;
    }
    let rowTop = drawTableHead(HEAD_TOP);

    // ===== Tabla: filas de items (sin filas en blanco) =====
    items.forEach((item, i) => {
        const descLines = doc.splitTextToSize(item.name || '', DESC_R - NUM_R - 12);
        const rowH = Math.max(ROW_H, descLines.length * LINE_H + 10);

        if (rowTop + rowH > PAGE_H - 60) {
            doc.addPage();
            rowTop = drawTableHead(40);
        }

        const yT = rowTop, yB = rowTop + rowH;
        bodyVx.forEach(x => ln(x, yT, x, yB));
        ln(L, yB, R, yB);

        const itemTotal = item.quantity * item.unit_price;
        const incidencia = total > 0 ? (itemTotal / total) * 100 : 0;
        T(String(i + 1), (L + NUM_R) / 2, yT + 5.4, { b: true, size: 9, align: 'center' });
        descLines.forEach((dl, k) => T(dl, NUM_R + 6.3, yT + 5.1 + k * LINE_H, { size: 8.5 }));
        T(item.unit || '', (DESC_R + UNIT_R) / 2, yT + 5.4, { size: 9, align: 'center' });
        T(qtyAR(item.quantity), QTY_R - 5, yT + 5.4, { size: 9, align: 'right' });
        T(moneyAR(item.unit_price), PU_R - 5, yT + 5.4, { size: 9, align: 'right' });
        T(moneyAR(itemTotal), PI_R - 5, yT + 5.4, { size: 9, align: 'right' });
        T(pctAR(incidencia), R - 5, yT + 5.4, { size: 9, align: 'right' });
        rowTop = yB;
    });

    // ===== Fila de total (PRECIO ITEMS + % = 100%) =====
    const totT = rowTop, totB = rowTop + ROW_H;
    box(PU_R, totT, PI_R, totB);  // celda total
    box(PI_R, totT, R, totB);     // celda 100%
    T(moneyAR(total), PI_R - 5, totT + 4.9, { b: true, size: 9.5, align: 'right' });
    T(pctAR(total > 0 ? 100 : 0), R - 5, totT + 4.9, { b: true, size: 9.5, align: 'right' });

    // ===== Aclaración IVA (a la izquierda, sin recuadro) =====
    T('LOS PRECIOS UNITARIOS INCLUYEN IVA', 42.8, totB + 3.3, { b: true, size: 8 });

    // ===== Caja SON PESOS (monto en letras) =====
    const spTop = totB + 21.5;
    box(L, spTop, R, spTop + 26);
    T('SON PESOS: ' + montoEnLetras(total), 51, spTop + 7.6, { b: true, size: 9, maxW: R - 51 - 8 });

    // ===== Guardar =====
    doc.save(pdfFileName(budget));
}
