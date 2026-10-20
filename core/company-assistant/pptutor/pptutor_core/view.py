"""Compact Agent view: keep every page's text, store repeated provenance once."""
def compact(result):
    out=dict(result)
    documents={}
    scope=dict(out.get('scope',{}))
    if scope:
        out['scope']=scope
    if 'candidates' in out:
        items=[]
        for source in out['candidates']:
            item=dict(source); ref=item.pop('ref')
            fid=str(ref['file_id'])
            documents[fid]={k:ref[k] for k in ('path','name','content_hash','indexed_at')}
            item['page_hash']=ref['page_hash']
            item['duplicate_refs']=source.get('duplicate_refs',[])
            items.append(item)
        out['candidates']=items
    if 'pages' in out:
        items=[]
        for source in out['pages']:
            item=dict(source); ref=item.pop('ref')
            fid=str(ref['file_id'])
            documents[fid]={k:ref[k] for k in ('path','name','content_hash','indexed_at')}
            item['page_hash']=ref['page_hash']
            items.append(item)
        out['pages']=items
    if documents: out['documents']=documents
    out['compact_view']=True
    out['view_note']='Complete page text retained; per-document provenance appears once. Saved --save files retain the original full envelope.'
    return out
