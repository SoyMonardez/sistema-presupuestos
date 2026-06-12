// Export a PDF — réplica del formato "Etan Construcción" (presupuesto original del emisor).
// Datos del emisor — editá estos valores si cambian:
const PDF_EMISOR = {
    nombre: 'ETAN CONSTRUCCIÓN',
    subtitulo: 'Cómputo y Presupuesto Oficial de Mano de Obra',
    telefono: '+54 9 264 570-0122',
    telefonoCorto: '264 5700122',
    origen: 'San Juan, Argentina',
    ciudad: 'San Juan, Capital',
    firma: 'Etan Construcción',
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

function exportBudgetPDF(budget, items) {
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
    const safeName = (budget.name || 'presupuesto')
        .toLowerCase()
        .normalize('NFD')
        .split('').filter(c => c.charCodeAt(0) < 0x300 || c.charCodeAt(0) > 0x36f).join('')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '');
    const fileDate = new Date().toISOString().slice(0, 10);
    doc.save(`presupuesto-${safeName}-${fileDate}.pdf`);
}
