// Export a PDF con jsPDF + autotable.
// Datos del emisor — editá estos valores con los datos reales:
const PDF_EMISOR = {
    nombre: 'Presupuesto',
    subtitulo: '',           // ej: "Construcción y refacciones"
    telefono: '',            // ej: "+54 9 11 1234-5678"
    email: '',
};

function exportBudgetPDF(budget, items) {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: 'mm', format: 'a4' });
    const pageWidth = doc.internal.pageSize.getWidth();
    const margin = 16;
    let y = 20;

    // ---------- Encabezado ----------
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(20);
    doc.setTextColor(30, 33, 48);
    doc.text(PDF_EMISOR.nombre, margin, y);

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    doc.setTextColor(120);
    const contactBits = [PDF_EMISOR.subtitulo, PDF_EMISOR.telefono, PDF_EMISOR.email].filter(Boolean);
    if (contactBits.length) {
        y += 6;
        doc.text(contactBits.join('  ·  '), margin, y);
    }

    const fecha = new Date().toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric' });
    doc.text(`Fecha: ${fecha}`, pageWidth - margin, 20, { align: 'right' });

    y += 12;
    doc.setDrawColor(79, 124, 255);
    doc.setLineWidth(0.8);
    doc.line(margin, y, pageWidth - margin, y);
    y += 10;

    // ---------- Datos del presupuesto ----------
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(15);
    doc.setTextColor(30, 33, 48);
    doc.text(budget.name || 'Presupuesto', margin, y);
    y += 7;

    if (budget.client) {
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(11);
        doc.setTextColor(90);
        doc.text(`Cliente: ${budget.client}`, margin, y);
        y += 7;
    }
    y += 3;

    // ---------- Tabla de items ----------
    const body = items.map(item => [
        item.name,
        String(item.quantity),
        item.unit,
        formatARS(item.unit_price),
        formatARS(item.quantity * item.unit_price),
    ]);

    doc.autoTable({
        startY: y,
        margin: { left: margin, right: margin },
        head: [['Descripción', 'Cant.', 'Unidad', 'Precio unit.', 'Subtotal']],
        body,
        theme: 'striped',
        styles: { fontSize: 10, cellPadding: 3 },
        headStyles: { fillColor: [79, 124, 255], textColor: 255, fontStyle: 'bold' },
        columnStyles: {
            0: { cellWidth: 'auto' },
            1: { cellWidth: 16, halign: 'right' },
            2: { cellWidth: 20 },
            3: { cellWidth: 32, halign: 'right' },
            4: { cellWidth: 34, halign: 'right' },
        },
    });

    // ---------- Total ----------
    const total = items.reduce((sum, i) => sum + i.quantity * i.unit_price, 0);
    let endY = doc.lastAutoTable.finalY + 10;

    // Si el total no entra en la página, pasamos a una nueva
    if (endY > doc.internal.pageSize.getHeight() - 30) {
        doc.addPage();
        endY = 24;
    }

    doc.setFillColor(240, 244, 255);
    doc.roundedRect(pageWidth - margin - 80, endY - 7, 80, 14, 2, 2, 'F');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(13);
    doc.setTextColor(30, 33, 48);
    doc.text('TOTAL', pageWidth - margin - 75, endY + 2);
    doc.text(formatARS(total), pageWidth - margin - 5, endY + 2, { align: 'right' });

    if (budget.notes) {
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(10);
        doc.setTextColor(110);
        doc.text(doc.splitTextToSize(`Notas: ${budget.notes}`, pageWidth - margin * 2), margin, endY + 16);
    }

    // ---------- Guardar ----------
    const safeName = (budget.name || 'presupuesto')
        .toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '');
    const fileDate = new Date().toISOString().slice(0, 10);
    doc.save(`presupuesto-${safeName}-${fileDate}.pdf`);
}
