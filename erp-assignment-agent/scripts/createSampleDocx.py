import os
import zipfile

content_types = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>"""

rels = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>"""

document_xml = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>Subject: MATH202 Linear Algebra</w:t></w:r></w:p>
    <w:p><w:r><w:t>Homework 4: Eigenvalues, Eigenvectors, and Diagonalization Proofs</w:t></w:r></w:p>
    <w:p><w:r><w:t>Student Name: Alex Carter | Student ID: student_2026</w:t></w:r></w:p>
    <w:p><w:r><w:t>Problem Set 4 Solutions:</w:t></w:r></w:p>
    <w:p><w:r><w:t>Question 1: Compute the characteristic polynomial det(A - lambda*I) = 0 for the 3x3 matrix. The roots yield eigenvalues lambda_1 = 3, lambda_2 = 1, lambda_3 = -2.</w:t></w:r></w:p>
    <w:p><w:r><w:t>Question 2: Verification of algebraic multiplicity vs geometric multiplicity. We show dim(Null(A - 3I)) = 1, confirming the eigenspace dimension.</w:t></w:r></w:p>
    <w:p><w:r><w:t>Question 3: Orthogonal diagonalization of real symmetric matrices. Using the Gram-Schmidt orthonormalization process, we construct orthogonal matrix P such that P^T A P = D.</w:t></w:r></w:p>
  </w:body>
</w:document>"""

target_dir = os.path.join(os.path.dirname(__file__), "..", "college_assignments")
os.makedirs(target_dir, exist_ok=True)
docx_path = os.path.join(target_dir, "MATH202_Linear_Algebra_Homework_4.docx")

print(f"[Sample Generator] Writing DOCX to: {docx_path}")
with zipfile.ZipFile(docx_path, "w", compression=zipfile.ZIP_DEFLATED) as z:
    z.writestr("[Content_Types].xml", content_types)
    z.writestr("_rels/.rels", rels)
    z.writestr("word/document.xml", document_xml)

print("[Sample Generator] DOCX created successfully!")

