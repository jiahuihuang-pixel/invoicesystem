// In the browser, pdf-lib comes from a <script> tag (window.PDFLib). This
// lets render.js import it the same way the server does.
const L = window.PDFLib;
export const PDFDocument = L.PDFDocument;
export const StandardFonts = L.StandardFonts;
export const rgb = L.rgb;
