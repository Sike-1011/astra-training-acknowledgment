/* =========================================================================
   CONFIG — this is the only file you normally need to edit.
   ========================================================================= */
window.APP_CONFIG = {

  /* -----------------------------------------------------------------------
     1) PASTE YOUR GOOGLE APPS SCRIPT WEB APP URL HERE.
        Deploy > New deployment > Web app > Execute as: Me,
        Who has access: Anyone. Copy the /exec URL.
     --------------------------------------------------------------------- */
  ENDPOINT: 'https://script.google.com/macros/s/AKfycbyQUA189-GDhMiwzoG4kWfTcliPLotZMEccxv0HNKBeQVN29bmUcb7PHD3VgMxR_gbTsQ/exec',

  /* Company name shown in messages */
  COMPANY: 'Astra Global',

  /* Minimum seconds a document must stay open before the certify checkbox
     unlocks. Set to 0 to disable the timer entirely. */
  MIN_READ_SECONDS: 20,

  /* Also require the reader to scroll to the last page before they can certify.
     Documents short enough to fit on screen unlock without scrolling.
     Set to false to drop this and rely on the timer alone. */
  REQUIRE_SCROLL_TO_END: true,

  /* Save progress in the browser so a refresh doesn't lose everything. */
  PERSIST_PROGRESS: true,

  /* The documents, in the order they must be read.
     - id      : short, stable key. Becomes the spreadsheet column name.
     - title   : shown as the heading
     - desc    : one-line description under the heading
     - file    : path relative to index.html
     - version : bump this when you replace the PDF, so old sign-offs stay
                 distinguishable from new ones in the sheet.
     - link    : the Google Drive (or other) URL for this document. This is what
                 gets written into the spreadsheet, so whoever reviews the log
                 can click straight through to the exact document that was
                 signed off.  */
  DOCUMENTS: [
    {
      id: 'compliance_sop',
      title: 'Compliance SOP',
      desc: 'Standard operating procedure for compliance obligations.',
      file: 'docs/compliance-sop.pdf',
      version: 'v1.0',
      link: 'https://drive.google.com/file/d/196YpbIKOpJsVF2avUNB-RmRrpYHItHJD/view?usp=sharing'
    },
    {
      id: 'leave_policy_sop',
      title: 'Leave Policy During Training SOP',
      desc: 'How leave is applied for, approved and recorded during the training period.',
      file: 'docs/leave-policy-training-sop.pdf',
      version: 'v1.0',
      link: 'https://drive.google.com/file/d/1kF2KLYWPZ-F0SXajMEjeeABqk08fOgQX/view?usp=sharing'
    },
    {
      id: 'training_dos_donts',
      title: "Training Do's & Don'ts",
      desc: 'Expected conduct and ground rules for the training programme.',
      file: 'docs/training-dos-and-donts.pdf',
      version: 'v1.0',
      link: 'https://drive.google.com/file/d/1hZLk7obqVsYF8t1VmG3C-G7jtgj9USiG/view?usp=sharing'
    }
  ]
};
